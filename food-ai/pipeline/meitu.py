# -*- coding: utf-8 -*-
"""美图抠图 API（实验）：调用官方 meitu-cli 的 image-cutout，输出透明底 PNG。

与识别流程并行调用（上传原图→云端抠图→下载结果），失败时由调用方回退本地抠图。
环境变量：
  MEITU_OPENAPI_ACCESS_KEY / MEITU_OPENAPI_SECRET_KEY  凭证（必填，缺失则跳过）
  FOOD_MEITU_CUTOUT=0        关闭美图抠图
  FOOD_MEITU_MODEL_TYPE      0 人像 / 1 商品 / 2 图形（默认 1 商品）
  FOOD_MEITU_CLI             meitu 可执行文件路径（默认自动查找）
  FOOD_MEITU_TIMEOUT         单次调用超时秒数，默认 180
  FOOD_MEITU_MAX_SIDE        返回图最长边，默认 640（前端展示用，控制响应体积）
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

import cv2
import numpy as np

AUTH_ERROR_HINTS = ("access key not found", "invalid access key", "unauthorized",
                    "authentication failed", "invalid credential")


class AuthError(Exception):
    """美图密钥无效/未授权（用于前端提示重新填写）。"""


def is_auth_error(*texts):
    low = " ".join(str(t or "") for t in texts).lower()
    return any(h in low for h in AUTH_ERROR_HINTS)


def _find_cli():
    path = os.environ.get("FOOD_MEITU_CLI", "").strip()
    if path and os.path.exists(path):
        return path
    found = shutil.which("meitu")
    if found:
        return found
    for pattern in ("/home/ubuntu/.nvm/versions/node/*/bin/meitu",
                    os.path.expanduser("~/.nvm/versions/node/*/bin/meitu")):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return None


def enabled(access_key=None, secret_key=None):
    """通道是否可用：显式传用户密钥时只要求密钥存在，否则看服务端密钥。"""
    if os.environ.get("FOOD_MEITU_CUTOUT", "1").strip().lower() in ("0", "false", "off", "no"):
        return False
    if access_key and secret_key:
        return True
    return bool(os.environ.get("MEITU_OPENAPI_ACCESS_KEY")
                and os.environ.get("MEITU_OPENAPI_SECRET_KEY"))


def _parse_json(text):
    text = str(text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except Exception:  # noqa: BLE001
                return None
        return None


def _download(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def shrink_png(png):
    """把结果缩到 FOOD_MEITU_MAX_SIDE 内，控制回传体积（前端只展示 640）。"""
    max_side = int(os.environ.get("FOOD_MEITU_MAX_SIDE", "640"))
    try:
        img = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if img is None:
            return png
        h, w = img.shape[:2]
        if max(h, w) <= max_side:
            return png
        scale = max_side / float(max(h, w))
        img = cv2.resize(img, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                         interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", img)
        return buf.tobytes() if ok else png
    except Exception:  # noqa: BLE001
        return png


def cutout(image_bgr, log=print, timeout=None, access_key=None, secret_key=None):
    """调用美图抠图，返回 RGBA PNG 字节；失败返回 None。

    access_key/secret_key：用户自带的 MeituHub 密钥（试用期结束后由账号服务注入），
    为空时用服务端环境变量里的密钥。
    """
    cli = _find_cli()
    if not cli:
        log("[meitu] 未找到 meitu CLI，跳过")
        return None
    timeout = timeout or int(os.environ.get("FOOD_MEITU_TIMEOUT", "180"))
    model_type = str(os.environ.get("FOOD_MEITU_MODEL_TYPE", "1")).strip() or "1"
    tmpdir = tempfile.mkdtemp(prefix="foodai_meitu_")
    in_path = os.path.join(tmpdir, "input.jpg")
    out_dir = os.path.join(tmpdir, "out")
    try:
        os.makedirs(out_dir, exist_ok=True)
        ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            return None
        with open(in_path, "wb") as f:
            f.write(buf.tobytes())
        cmd = [cli, "image-cutout", "--image_url", in_path,
               "--model_type", model_type, "--download-dir", out_dir, "--json"]
        t0 = time.time()
        env = dict(os.environ)
        if access_key and secret_key:
            env["MEITU_OPENAPI_ACCESS_KEY"] = str(access_key)
            env["MEITU_OPENAPI_SECRET_KEY"] = str(secret_key)
            # 每个账号独立 HOME：CLI 的工具注册表缓存按账号标识校验，
            # 共用 ~/.meitu 会互相覆盖导致每次重新拉取（甚至并发写坏）
            home = os.path.join(tempfile.gettempdir(), "foodai_meitu_home",
                                hashlib.sha256(str(access_key).encode()).hexdigest()[:16])
            os.makedirs(home, exist_ok=True)
            env["HOME"] = home
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout,
                                  env=env)
        except subprocess.TimeoutExpired:
            log("[meitu] 抠图超时 %ss" % timeout)
            return None
        data = _parse_json(proc.stdout.decode("utf-8", "ignore"))
        if not data or not data.get("ok"):
            stderr = proc.stderr.decode("utf-8", "ignore")
            log("[meitu] 抠图失败 code=%s message=%s stderr=%s" % (
                (data or {}).get("code"), (data or {}).get("message"), stderr[:200]))
            if is_auth_error((data or {}).get("message"), stderr):
                raise AuthError(((data or {}).get("message") or stderr)[:200])
            return None
        png = None
        for item in data.get("downloaded_files") or []:
            saved = item.get("saved_path")
            if saved and os.path.exists(saved):
                with open(saved, "rb") as f:
                    png = f.read()
                break
        if png is None:
            for url in data.get("media_urls") or []:
                try:
                    png = _download(url)
                    break
                except Exception:  # noqa: BLE001
                    continue
        if not png:
            log("[meitu] 抠图结果为空: %s" % json.dumps(data, ensure_ascii=False)[:200])
            return None
        log("[meitu] 抠图完成 用时%.1fs %d字节 task=%s" % (
            time.time() - t0, len(png), data.get("task_id", "")))
        return shrink_png(png)
    except Exception as e:  # noqa: BLE001
        if isinstance(e, AuthError):
            raise
        log("[meitu] 抠图异常: %s" % e)
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
