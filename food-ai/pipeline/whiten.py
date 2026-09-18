# -*- coding: utf-8 -*-
"""换底：调用 DashScope qwen-image-edit 把随手拍照片的背景换成纯色。

动机：杂乱背景（桌面/墙面/杂物）下 U2NET/SAM2 容易把食物抠碎；
先让图像编辑模型把背景换成纯色（食物/餐具保持不变），再走后续抠图与识别，
抠图边缘明显更完整。实测同一张照片换底后，主食/汤碗/配菜不再残缺。

配色规则：白色、透明、玻璃材质的餐具在白底上几乎没有边缘对比，容易抠缺；
这类主体换纯粉底，其他主体仍换纯白底（颜色可用环境变量调整）。

失败（网络/限流/额度/内容审核）时返回 None，调用方回退原图，保证流程可用。
环境变量：
  FOOD_WHITEN_BG=0        关闭换底（默认开启）
  FOOD_WHITEN_WHITE       白色底，默认 #FFFFFF
  FOOD_WHITEN_PINK        粉色底，默认 #FFC0CB
  FOOD_WHITEN_PROMPT      完全自定义提示词（设置后忽略上面的配色）
  QWEN_IMAGE_EDIT_MODEL   默认 qwen-image-edit
  FOOD_WHITEN_TIMEOUT     生成超时秒数，默认 120
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

DASHSCOPE_EDIT_URL = os.environ.get(
    "QWEN_IMAGE_EDIT_URL",
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
)
EDIT_MODEL = os.environ.get("QWEN_IMAGE_EDIT_MODEL", "qwen-image-edit")

WHITE = os.environ.get("FOOD_WHITEN_WHITE", "#FFFFFF")
PINK = os.environ.get("FOOD_WHITEN_PINK", "#FFC0CB")

DEFAULT_PROMPT = (
    "只把照片中餐具和食物以外的背景（桌面、台面、墙面、地面、阴影、杂物）替换成纯色背景，"
    "不要渐变、不要纹理；"
    "如果餐具是白色、米色、透明或玻璃材质，背景换成纯粉色 %s；其他情况背景换成纯白色 %s；"
    "注意：颜色只作用于背景，绝不能把白色/透明/玻璃餐具本身染成粉色或任何背景色，"
    "白色餐具必须保持白色；"
    "碗、盘、杯等餐具和食物必须原样保留：保持它们原有的形状、颜色、纹理、明暗、阴影、反光和位置；"
    "不要给餐具重新上色，不要抹平餐具的立体感和边缘阴影；"
    "不要添加原图中不存在的物体，不要添加文字水印。" % (PINK, WHITE)
)
PROMPT = os.environ.get("FOOD_WHITEN_PROMPT", DEFAULT_PROMPT)
NEGATIVE_PROMPT = "文字, 水印, 模糊, 变形, 桌面, 桌布, 背景杂物, 阴影, 新增物体, 脑补, 幻想, 多余餐具, 渐变背景"


def enabled():
    return os.environ.get("FOOD_WHITEN_BG", "1").strip().lower() not in ("0", "false", "off", "no", "")


def is_white_background(image_bgr, band_ratio=0.06, bright=245, ratio=0.92):
    """边框区域几乎全白时认为已经是白底，无需再调用编辑接口。"""
    h, w = image_bgr.shape[:2]
    band = max(2, int(min(h, w) * band_ratio))
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    border = np.concatenate([
        gray[:band, :].ravel(), gray[h - band:, :].ravel(),
        gray[:, :band].ravel(), gray[:, w - band:].ravel(),
    ])
    return float((border >= bright).mean()) >= ratio


def _border_hsv(image_bgr, band_ratio=0.06):
    h, w = image_bgr.shape[:2]
    band = max(2, int(min(h, w) * band_ratio))
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    return np.concatenate([
        hsv[:band, :].reshape(-1, 3), hsv[h - band:, :].reshape(-1, 3),
        hsv[:, :band].reshape(-1, 3), hsv[:, w - band:].reshape(-1, 3),
    ])


def is_plain_background(image_bgr, band_ratio=0.06, ratio=0.9):
    """边框区域几乎为纯白或纯浅粉时，认为已是干净底色，无需再调用编辑接口。"""
    border = _border_hsv(image_bgr, band_ratio)
    hh, ss, vv = border[:, 0], border[:, 1], border[:, 2]
    white = (vv >= 235) & (ss <= 30)
    pink = (vv >= 210) & (ss >= 25) & (ss <= 160) & ((hh >= 150) | (hh <= 10))
    return float((white | pink).mean()) >= ratio


def background_color(image_bgr, band_ratio=0.06, ratio=0.5):
    """返回边框区域的主要颜色名（粉/白/其他），用于日志排查换底效果。"""
    border = _border_hsv(image_bgr, band_ratio)
    hh, ss, vv = border[:, 0], border[:, 1], border[:, 2]
    pink = (vv >= 210) & (ss >= 25) & (ss <= 160) & ((hh >= 150) | (hh <= 10))
    if float(pink.mean()) >= ratio:
        return "粉"
    if float(((vv >= 235) & (ss <= 30)).mean()) >= ratio:
        return "白"
    return "其他"


def key_alpha(image_bgr, band_ratio=0.04, thr=18.0, min_area=300, border_ratio=0.5):
    """纯色底颜色键：返回非背景区域掩码（uint8 0/255），背景不够纯时返回 None。

    换底后背景是均匀纯色，用边框估计背景色，与背景色距离足够大的像素即主体；
    这样 U2NET 漏掉的餐具（白碗/玻璃碗）也能完整保留。
    背景色估计优先用四角小块（主体常贴近边框，四角更稳），
    失败再对边框像素迭代取中值（逐步剔除主体像素），容忍主体占住部分边框。
    """
    h, w = image_bgr.shape[:2]
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    band = max(2, int(min(h, w) * band_ratio))
    border = np.concatenate([
        lab[:band, :].reshape(-1, 3), lab[h - band:, :].reshape(-1, 3),
        lab[:, :band].reshape(-1, 3), lab[:, w - band:].reshape(-1, 3),
    ])

    def inlier_ratio(bg):
        d = np.sqrt(((border - bg) ** 2).sum(axis=1))
        return float((d < thr).mean())

    # 1) 四角小块估计背景色
    pad = max(3, int(min(h, w) * 0.03))
    corners = np.concatenate([
        lab[:pad, :pad].reshape(-1, 3), lab[:pad, -pad:].reshape(-1, 3),
        lab[-pad:, :pad].reshape(-1, 3), lab[-pad:, -pad:].reshape(-1, 3),
    ])
    bg = np.median(corners, axis=0)
    if inlier_ratio(bg) < border_ratio:
        # 2) 回退：边框像素迭代取中值，剔除被主体占住的边框像素
        bg = np.median(border, axis=0)
        for _ in range(3):
            d = np.sqrt(((border - bg) ** 2).sum(axis=1))
            inliers = border[d < thr]
            if len(inliers) < 50:
                return None
            bg = np.median(inliers, axis=0)
    if inlier_ratio(bg) < border_ratio:
        return None
    dist = np.sqrt(((lab - bg) ** 2).sum(axis=2))
    key = (dist > thr).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    key = cv2.morphologyEx(key, cv2.MORPH_CLOSE, k, iterations=2)
    key = cv2.morphologyEx(key, cv2.MORPH_OPEN, k, iterations=1)
    key = cv2.erode(key, k, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(key)
    keep = np.zeros_like(key)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            keep[labels == i] = 255
    return keep if keep.any() else None


def subject_may_be_white(image_bgr, center_ratio=0.55, bright=190, sat_max=50, ratio=0.08):
    """中心区域高亮低饱和像素达到一定比例时，认为主体可能含白色/透明/玻璃餐具。

    仅用于判断"已是纯色底时要不要再换一次底"：宁可多调一次编辑接口，
    也别把白碗/玻璃碗留在白底上导致抠缺。
    """
    h, w = image_bgr.shape[:2]
    ch, cw = max(1, int(h * center_ratio)), max(1, int(w * center_ratio))
    y0, x0 = (h - ch) // 2, (w - cw) // 2
    crop = image_bgr[y0:y0 + ch, x0:x0 + cw]
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    ss, vv = hsv[:, :, 1], hsv[:, :, 2]
    mask = (vv >= bright) & (ss <= sat_max)
    return float(mask.mean()) >= ratio


def align_original(orig_bgr, target_bgr, min_inliers=60):
    """把换底前原图对齐到换底图的几何（编辑模型可能缩放/平移主体）。

    掩码是按换底图算的，抠图要用原图颜色时必须先对齐，否则主体错位。
    相似变换（缩放+旋转+平移）用 ORB 特征 + RANSAC 估计；
    匹配点不足或缩放异常时返回 None，调用方回退换底图。
    """
    import cv2
    import numpy as np

    try:
        g1 = cv2.cvtColor(orig_bgr, cv2.COLOR_BGR2GRAY)
        g2 = cv2.cvtColor(target_bgr, cv2.COLOR_BGR2GRAY)
        orb = cv2.ORB_create(2000)
        k1, d1 = orb.detectAndCompute(g1, None)
        k2, d2 = orb.detectAndCompute(g2, None)
        if d1 is None or d2 is None:
            return None
        bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        matches = sorted(bf.match(d1, d2), key=lambda m: m.distance)[:400]
        if len(matches) < min_inliers:
            return None
        src = np.float32([k1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
        dst = np.float32([k2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
        m, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                             ransacReprojThreshold=3.0)
        if m is None or inl is None or int(inl.sum()) < min_inliers:
            return None
        scale = float(np.hypot(m[0, 0], m[1, 0]))
        if not 0.5 <= scale <= 2.0:
            return None
        h, w = target_bgr.shape[:2]
        return cv2.warpAffine(orig_bgr, m, (w, h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
    except Exception:  # noqa: BLE001
        return None


def _download(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def whiten_background(image_bytes, mime="image/jpeg", log=print, api_key=None):
    """把图片背景换成纯白色，返回 PNG 字节；失败返回 None。"""
    key = str(api_key or os.environ.get("DASHSCOPE_API_KEY", "") or "").strip()
    if not key:
        log("[whiten] 未配置 DASHSCOPE_API_KEY，跳过白底化")
        return None
    b64 = base64.b64encode(image_bytes).decode()
    body = {
        "model": EDIT_MODEL,
        "input": {"messages": [{"role": "user", "content": [
            {"image": "data:%s;base64,%s" % (mime, b64)},
            {"text": PROMPT},
        ]}]},
        "parameters": {"n": 1, "watermark": False, "negative_prompt": NEGATIVE_PROMPT},
    }
    timeout = int(os.environ.get("FOOD_WHITEN_TIMEOUT", "120"))
    req = urllib.request.Request(
        DASHSCOPE_EDIT_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        log("[whiten] 换白底请求失败 HTTP %s: %s" % (e.code, detail))
        return None
    except Exception as e:  # noqa: BLE001
        log("[whiten] 换白底请求异常: %s" % e)
        return None
    content = ((data.get("output") or {}).get("choices") or [{}])[0].get("message", {}).get("content") or []
    img_url = next((c.get("image") for c in content if isinstance(c, dict) and c.get("image")), None)
    if not img_url:
        log("[whiten] 换白底响应无图片: %s" % json.dumps(data, ensure_ascii=False)[:300])
        return None
    try:
        png = _download(img_url)
    except Exception as e:  # noqa: BLE001
        log("[whiten] 换白底图片下载失败: %s" % e)
        return None
    log("[whiten] 换白底完成 用时%.1fs %d字节 usage=%s" % (
        time.time() - t0, len(png), json.dumps(data.get("usage") or {}, ensure_ascii=False)))
    return png
