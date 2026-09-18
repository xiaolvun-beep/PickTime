# -*- coding: utf-8 -*-
"""美图AI开放平台（ai.meitu.com）智能抠图 API。

与 MeituHub（meituhub.cn，Credits 计费）不同：本接口走开放平台资源包/试用额度。
  正式环境：https://openapi.meitu.com
  任务提交：POST /api/v1/sdk/sync/push
  任务：/v1/photo_scissors/sod（智能抠图(AI开放平台)）
  签名：SDK-HMAC-SHA256（AIGCP-API，Authorization 为 base64 包装的 Bearer）

环境变量：
  MEITU_OPEN_AK / MEITU_OPEN_SK  开放平台 API Key / Secret（服务端密钥，缺失则跳过）
  cutout(access_key=..., secret_key=...) 可传用户自己的密钥（MeituHub AK/SK，与 CLI 同源）
  FOOD_MEITU_OPEN=0              关闭本通道
  FOOD_MEITU_OPEN_TASK           默认 /v1/photo_scissors/sod（另有 /v1/sod）
  FOOD_MEITU_OPEN_MODEL_TYPE     0 人像 / 1 商品 / 2 图形，默认 1
  FOOD_MEITU_OPEN_TIMEOUT        单次调用超时秒数，默认 120
  FOOD_MEITU_MAX_SIDE            返回图最长边，默认 640（与 MeituHub 通道一致）
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import time
import urllib.request

import cv2
import numpy as np

from .meitu import AuthError, is_auth_error, shrink_png

API_HOST = "openapi.meitu.com"
API_URL = "https://%s/api/v1/sdk/sync/push" % API_HOST
STATUS_URL = "https://%s/api/v1/sdk/status" % API_HOST
DATE_FMT = "%Y%m%dT%H%M%SZ"
PENDING_STATUS = (0, 1, 9)
SUCCESS_STATUS = 10


def enabled(access_key=None, secret_key=None):
    """通道是否可用：显式传用户密钥时只要求密钥存在，否则看服务端密钥。"""
    if os.environ.get("FOOD_MEITU_OPEN", "1").strip().lower() in ("0", "false", "off", "no"):
        return False
    if access_key and secret_key:
        return True
    return bool(os.environ.get("MEITU_OPEN_AK") and os.environ.get("MEITU_OPEN_SK"))


class _Signer:
    """AIGCP-API SDK-HMAC-SHA256 签名（与官方 python-sdk-1.0.3 一致）。"""

    ALGORITHM = "SDK-HMAC-SHA256"

    def __init__(self, key, secret):
        self.key = key
        self.secret = secret

    @staticmethod
    def _hash(data):
        return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()

    def sign(self, url, method, headers, body):
        from urllib.parse import urlparse, parse_qs, urlencode

        parsed = urlparse(url)
        path = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
        query = urlencode(sorted(parse_qs(parsed.query).items()), doseq=True)
        headers = dict(headers)
        headers.setdefault("X-Sdk-Date", datetime.datetime.now(datetime.timezone.utc).strftime(DATE_FMT))
        signed_headers = sorted(h.lower() for h in headers)
        low = {k.lower(): str(v).strip() for k, v in headers.items()}
        canonical_headers = "\n".join("%s:%s" % (h, low[h]) for h in signed_headers)
        payload_hash = self._hash(body)
        canonical_request = "\n".join([
            method, path, query, canonical_headers, ";".join(signed_headers), payload_hash,
        ])
        string_to_sign = "%s\n%s\n%s" % (
            self.ALGORITHM, headers["X-Sdk-Date"], self._hash(canonical_request))
        signature = hmac.new(self.secret.encode(), string_to_sign.encode(),
                             hashlib.sha256).hexdigest()
        auth = "%s Access=%s, SignedHeaders=%s, Signature=%s" % (
            self.ALGORITHM, self.key, ";".join(signed_headers), signature)
        headers["Authorization"] = "Bearer " + base64.b64encode(auth.encode()).decode()
        return headers


def _download(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def _fetch_status(key, secret, task_id, timeout=30):
    from urllib.parse import urlencode

    url = STATUS_URL + "?" + urlencode({"task_id": task_id})
    headers = _Signer(key, secret).sign(url, "GET", {"Host": API_HOST}, "")
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def cutout(image_bgr, log=print, timeout=None, access_key=None, secret_key=None):
    """调用开放平台智能抠图，返回 RGBA PNG 字节；失败返回 None。

    access_key/secret_key：用户自己的 MeituHub 密钥（试用期结束后由账号服务注入），
    为空时用服务端环境变量里的密钥。
    """
    key = str(access_key or os.environ.get("MEITU_OPEN_AK", "")).strip()
    secret = str(secret_key or os.environ.get("MEITU_OPEN_SK", "")).strip()
    if not key or not secret:
        log("[meitu-open] 未配置 MEITU_OPEN_AK/SK，跳过")
        return None
    timeout = timeout or int(os.environ.get("FOOD_MEITU_OPEN_TIMEOUT", "120"))
    task = os.environ.get("FOOD_MEITU_OPEN_TASK", "/v1/photo_scissors/sod").strip()
    try:
        model_type = int(os.environ.get("FOOD_MEITU_OPEN_MODEL_TYPE", "1"))
    except ValueError:
        model_type = 1
    ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return None
    params = {"parameter": {
        "nMask": False,
        "model_type": model_type,
        "post_matting": True,
        "use_fe_rgba": True,
    }}
    payload = {
        "params": json.dumps(params),
        "task": task,
        "task_type": "mtlab",
        "init_images": [{
            "url": base64.b64encode(buf.tobytes()).decode(),
            "profile": {"media_profiles": {"media_data_type": "jpg"}, "version": "v1"},
        }],
        "sync_timeout": 30,
        "rsp_media_type": "url",
    }
    body = json.dumps(payload)
    headers = _Signer(key, secret).sign(
        API_URL, "POST", {"Content-Type": "application/json", "Host": API_HOST}, body)
    req = urllib.request.Request(API_URL, data=body.encode(), headers=headers, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        log("[meitu-open] 抠图失败 HTTP %s: %s" % (e.code, detail))
        if e.code in (401, 403) or is_auth_error(detail):
            raise AuthError(detail)
        return None
    except Exception as e:  # noqa: BLE001
        log("[meitu-open] 抠图异常: %s" % e)
        return None
    d = data.get("data") or {}
    status = d.get("status")
    deadline = t0 + timeout
    while status in PENDING_STATUS and time.time() < deadline:
        task_id = str(d.get("task_id") or "").strip()
        if not task_id:
            break
        time.sleep(1.0)
        try:
            poll = _fetch_status(key, secret, task_id, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            log("[meitu-open] 查询任务失败: %s" % e)
            return None
        d = poll.get("data") or {}
        status = d.get("status")
    if status != SUCCESS_STATUS:
        message = str(data.get("message"))[:200]
        log("[meitu-open] 抠图未成功 status=%s code=%s message=%s" % (
            status, data.get("code"), message))
        if is_auth_error(message):
            raise AuthError(message)
        return None
    media = ((d.get("result") or {}).get("media_info_list") or [{}])[0]
    media_data = media.get("media_data")
    if not media_data:
        log("[meitu-open] 抠图结果为空: %s" % json.dumps(data, ensure_ascii=False)[:200])
        return None
    png = None
    if isinstance(media_data, str) and media_data.startswith("http"):
        try:
            png = _download(media_data)
        except Exception as e:  # noqa: BLE001
            log("[meitu-open] 结果下载失败: %s" % e)
            return None
    else:
        try:
            png = base64.b64decode(media_data)
        except Exception:  # noqa: BLE001
            return None
    log("[meitu-open] 抠图完成 输入%dx%d 用时%.1fs %d字节 task=%s" % (
        image_bgr.shape[1], image_bgr.shape[0], time.time() - t0, len(png), d.get("task_id", "")))
    return shrink_png(png)
