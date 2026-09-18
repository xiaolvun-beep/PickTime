# -*- coding: utf-8 -*-
"""识别流程编排：

  照片
   → 换底「更干净的画面」（qwen-image-edit 换纯色背景：白/透明/玻璃餐具用粉底，其他用白底，失败自动回退原图）
   → Qwen-VL「是什么」（并行发起网络请求）
   → YOLO26「在哪里」（校验/补充定位 + 餐具参照物）
   → SAM2「哪些像素」（逐食物掩码 → 面积）
   → Depth-Anything-V2「多厚」（掩码内深度 → 厚度）
   → 重量估算引擎「多少克」
   → 中国食物成分表「每100g营养」
   → 程序计算「总 kcal」
   → 按前端兼容格式输出（与 DashScope 返回结构一致）
"""
import base64
import json
import os
import re
import threading
import time

import cv2
import numpy as np

from . import meitu, meitu_open, qwen, whiten
from .nutrition import NutritionDB, normalize, strip_qualifier
from .vision import VisionModels, resize_for_models
from .weight import estimate_mass, estimate_scale, estimate_thickness, keyword_value

DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", re.S)

DEBUG_DIR = os.environ.get("FOOD_AI_DEBUG_DIR", "").strip()


def _debug_save(name, data):
    """排查用：把中间图写到 FOOD_AI_DEBUG_DIR（未设置则跳过）。"""
    if not DEBUG_DIR:
        return
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        path = os.path.join(DEBUG_DIR, name)
        if isinstance(data, np.ndarray):
            cv2.imwrite(path, data)
        else:
            with open(path, "wb") as f:
                f.write(data)
    except Exception:  # noqa: BLE001
        pass


def decode_data_url(url):
    m = DATA_URL_RE.match(str(url or "").strip())
    if not m:
        return None, None
    mime = m.group(1)
    try:
        raw = base64.b64decode(m.group(2))
    except Exception:
        return None, None
    return raw, mime


def extract_image_from_chat_body(body):
    """从 OpenAI/DashScope 兼容的请求体中取出图片。"""
    if isinstance(body, dict) and body.get("image"):
        raw, mime = decode_data_url(body["image"])
        if raw:
            return raw, mime
    for msg in (body.get("messages") or []) if isinstance(body, dict) else []:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url")
                    raw, mime = decode_data_url(url)
                    if raw:
                        return raw, mime
        elif isinstance(content, str):
            m = re.search(r"data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)", content)
            if m:
                try:
                    return base64.b64decode(re.sub(r"\s+", "", m.group(2))), m.group(1)
                except Exception:
                    pass
    return None, None


# 参照物"框不可信"时使用的中位尺寸（cm）
REF_TYPICAL_MID = {"盘": 22.0, "碟": 15.0, "碗": 15.0, "杯": 8.0, "罐": 6.6, "瓶": 6.5}

# 参照物典型尺寸合理区间（cm），防止模型给出偏离常识的尺寸放大面积估算
REF_SIZE_RANGES = {
    "盘": (16.0, 26.0), "碟": (12.0, 20.0), "碗": (10.0, 20.0), "杯": (6.0, 10.0),
    "瓶": (4.0, 10.0), "罐": (5.0, 9.0), "筷": (20.0, 28.0), "勺": (14.0, 20.0),
    "刀": (16.0, 22.0), "叉": (15.0, 21.0), "手": (15.0, 20.0), "托盘": (20.0, 35.0),
    "锅": (20.0, 32.0), "桌": (50.0, 120.0),
}


def clamp_ref_size(name, size):
    for kw, (lo, hi) in REF_SIZE_RANGES.items():
        if kw in str(name):
            return min(max(float(size), lo), hi)
    return float(size)


def _mask_key(key):
    s = str(key or "")
    if not s:
        return "(空)"
    if len(s) <= 8:
        return "****"
    return s[:4] + "****" + s[-4:]


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / max(1e-6, ua)


class RecognitionEngine:
    def __init__(self, log=print):
        self.log = log
        self.db = NutritionDB()
        self.vision = VisionModels(log=log)
        self._lock = threading.Lock()

    def load(self):
        self.vision.load()

    # ---------- 换底 ----------
    def _whiten_background(self, small, qwen_bytes, api_key=None):
        """把随手拍照片的背景换成纯色，返回 (处理图, 编码字节, 纯色底key)。

        白色/透明/玻璃餐具在白底上抠不干净，由编辑模型按提示词换粉底，其他换白底。
        换底成功后用背景色距离生成 key（补上 U2NET 不认的餐具）。
        已是纯色底且主体非白色、开关关闭或接口失败时原样返回，key 为 None。
        """
        if not whiten.enabled():
            return small, qwen_bytes, None
        _debug_save("last_whiten_input.jpg", small)
        if whiten.is_plain_background(small) and not whiten.subject_may_be_white(small):
            self.log("[whiten] 已是纯色底且主体非白色，跳过换底")
            return small, qwen_bytes, None
        png = whiten.whiten_background(qwen_bytes, mime="image/jpeg", log=self.log, api_key=api_key)
        if not png:
            return small, qwen_bytes, None
        _debug_save("last_whiten_output.png", png)
        img = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            self.log("[whiten] 换底图解码失败，回退原图")
            return small, qwen_bytes, None
        self.log("[whiten] 换底完成 背景色=%s" % whiten.background_color(img))
        small2, _ = resize_for_models(img, max_side=1024)
        key = whiten.key_alpha(small2)
        if key is not None:
            _debug_save("last_key_alpha.png", key)
        ok, buf = cv2.imencode(".jpg", small2, [cv2.IMWRITE_JPEG_QUALITY, 88])
        return small2, (buf.tobytes() if ok else png), key

    # ---------- 主流程 ----------
    def recognize(self, image_bytes, want_debug=False, progress=None, api_key=None,
                  meitu_ak=None, meitu_sk=None):
        def report(stage):
            if progress is None:
                return
            try:
                progress(stage)
            except Exception:  # noqa: BLE001
                pass

        t_start = time.time()
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("图片解码失败")
        small, scale = resize_for_models(img, max_side=1024)

        # 传给 Qwen 的图片使用降采样结果（最长边 1024），避免超大 base64 拖慢网络推理
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 88])
        qwen_bytes = buf.tobytes() if ok else image_bytes

        # 抠图：美图抠图 API（云端），用原图在 t=0 与识别流程并行跑，不占本机算力；
        # 通道优先级：用户自己的密钥(开放平台 REST) → 服务端开放平台(资源包/试用)
        # → 用户自己的密钥(MeituHub CLI) → 服务端 MeituHub(Credits)；
        # 失败/超时返回空 cutout，前端会自动回退本机 /api/cutout（U2NET）
        if meitu_open.enabled(meitu_ak, meitu_sk):
            self.log("[cutout] 通道=开放平台 密钥=用户 %s" % _mask_key(meitu_ak))
            cutout_provider = lambda image, log: meitu_open.cutout(  # noqa: E731
                image, log=log, access_key=meitu_ak, secret_key=meitu_sk)
        elif meitu.enabled(meitu_ak, meitu_sk):
            self.log("[cutout] 通道=MeituHub CLI 密钥=用户 %s" % _mask_key(meitu_ak))
            cutout_provider = lambda image, log: meitu.cutout(  # noqa: E731
                image, log=log, access_key=meitu_ak, secret_key=meitu_sk)
        elif meitu_open.enabled():
            self.log("[cutout] 通道=开放平台 密钥=服务端免费 %s" % _mask_key(os.environ.get("MEITU_OPEN_AK")))
            cutout_provider = meitu_open.cutout
        elif meitu.enabled():
            self.log("[cutout] 通道=MeituHub CLI 密钥=服务端 %s" % _mask_key(os.environ.get("MEITU_OPENAPI_ACCESS_KEY")))
            cutout_provider = meitu.cutout
        else:
            cutout_provider = None
        meitu_box = {}
        meitu_thread = None
        if cutout_provider is not None:
            def run_meitu():
                try:
                    meitu_box["png"] = cutout_provider(img, log=self.log)
                except meitu.AuthError as e:
                    self.log("[cutout] 美图密钥无效: %s" % e)
                    meitu_box["auth_error"] = True
                except Exception as e:  # noqa: BLE001
                    self.log("[cutout] 美图抠图异常: %s" % e)
                    meitu_box["png"] = None

            meitu_thread = threading.Thread(target=run_meitu, daemon=True)
            meitu_thread.start()

        # 识别/定位/重量全部直接用原图：换底（qwen-image-edit）已下线，
        # 它当初是为 U2NET 抠图完整性设计的，且会改色/缩放影响识别
        timings = {}
        h, w = small.shape[:2]
        diag = float(np.hypot(w, h))

        with self._lock:
            # 1) Qwen-VL 网络请求与本地模型并行
            qwen_result = {}

            def run_qwen():
                try:
                    res, elapsed, raw = qwen.recognize(qwen_bytes, mime="image/jpeg", api_key=api_key)
                    qwen_result.update(res)
                    qwen_result["_elapsed"] = elapsed
                    qwen_result["_raw"] = raw
                except Exception as e:  # noqa: BLE001
                    qwen_result["_error"] = str(e)

            qt = threading.Thread(target=run_qwen, daemon=True)
            qt.start()

            report("detect")
            t0 = time.time()
            yolo_items = self.vision.yolo(small)
            timings["yolo"] = round(time.time() - t0, 1)

            report("segment")
            t0 = time.time()
            self.vision.sam2_set_image(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
            timings["sam2_encoder"] = round(time.time() - t0, 1)

            report("depth")
            t0 = time.time()
            depth_map = self.vision.depth(small)
            timings["depth"] = round(time.time() - t0, 1)

            # 本地模型已算完，剩下等 Qwen 识别结果（耗时大头），单独上报阶段避免进度文案卡在深度
            report("qwen")
            qt.join(timeout=120)
            timings["qwen"] = round(qwen_result.get("_elapsed", 0), 1)

            # 2) 组装食物列表：Qwen 为主，YOLO 补充
            foods = self._merge_foods(qwen_result.get("foods") or [], yolo_items, w, h)
            refs = self._build_refs(qwen_result.get("references") or [], yolo_items, w, h,
                                    [f["bbox"] for f in foods if f.get("bbox")])
            # 组合饭/面（如鸭腿饭）：识别成一个菜名，而不是把配菜列成一大串
            combo_name = self._combo_name(foods, qwen_result, refs)

            # 3) 逐食物：SAM2 掩码 + 尺度 + 厚度 + 重量 + 营养
            out_foods = []
            report("weigh")
            t0 = time.time()
            for food in foods:
                item, _ = self._process_food(food, refs, yolo_items, small, depth_map,
                                             diag, w, h, want_debug)
                if item:
                    out_foods.append(item)
            timings["segment_weigh"] = round(time.time() - t0, 1)
            if combo_name and len(out_foods) >= 2:
                out_foods = [self._merge_combo(out_foods, combo_name)]

            # 抠图：取美图结果（并行已完成；无结果则返回空，由前端回退本机抠图）
            report("cutout")
            t0 = time.time()
            cutout_data_url = None
            cutout_auth_error = False
            if meitu_thread is not None:
                meitu_thread.join(timeout=float(os.environ.get("FOOD_MEITU_JOIN", "150")))
                png = meitu_box.get("png")
                if png:
                    cutout_data_url = "data:image/png;base64," + base64.b64encode(png).decode()
                    _debug_save("last_cutout.png", png)
                elif meitu_box.get("auth_error"):
                    cutout_auth_error = True
                    self.log("[cutout] 美图密钥无效，由前端提示重新填写")
                else:
                    self.log("[cutout] 美图抠图无结果，由前端回退本机抠图")
            timings["cutout"] = round(time.time() - t0, 1)

        report("finishing")
        total_kcal = sum(f["calories"] for f in out_foods)
        total_kcal = int(round(total_kcal))
        result = {
            "foods": out_foods,
            "totalCalories": total_kcal,
            "names": [f["name"] for f in out_foods],
            "timings": timings,
            "totalSeconds": round(time.time() - t_start, 1),
            "cutout": cutout_data_url,
        }
        if qwen_result.get("_error"):
            result["qwenError"] = qwen_result["_error"]
        if cutout_auth_error:
            result["cutoutError"] = "MEITU_KEY_INVALID"
        return result

    # ---------- 仅抠图（不识别） ----------
    def cutout_only(self, image_bytes, meitu_ak=None, meitu_sk=None):
        """只走美图抠图，返回 dataURL；失败返回 None（由调用方决定回退）。"""
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("图片解码失败")
        if meitu_open.enabled(meitu_ak, meitu_sk):
            self.log("[cutout] 通道=开放平台 密钥=用户 %s" % _mask_key(meitu_ak))
            png = meitu_open.cutout(img, log=self.log, access_key=meitu_ak, secret_key=meitu_sk)
        elif meitu.enabled(meitu_ak, meitu_sk):
            self.log("[cutout] 通道=MeituHub CLI 密钥=用户 %s" % _mask_key(meitu_ak))
            png = meitu.cutout(img, log=self.log, access_key=meitu_ak, secret_key=meitu_sk)
        elif meitu_open.enabled():
            self.log("[cutout] 通道=开放平台 密钥=服务端免费 %s" % _mask_key(os.environ.get("MEITU_OPEN_AK")))
            png = meitu_open.cutout(img, log=self.log)
        elif meitu.enabled():
            self.log("[cutout] 通道=MeituHub CLI 密钥=服务端 %s" % _mask_key(os.environ.get("MEITU_OPENAPI_ACCESS_KEY")))
            png = meitu.cutout(img, log=self.log)
        else:
            png = None
        if not png:
            return None
        _debug_save("last_cutout.png", png)
        return "data:image/png;base64," + base64.b64encode(png).decode()

    # ---------- 组装 ----------
    def _merge_foods(self, qwen_foods, yolo_items, w, h):
        foods = []
        for qf in qwen_foods:
            name = str(qf.get("name") or "").strip()
            if not name:
                continue
            bbox = self._qwen_bbox(qf.get("bbox"), w, h)
            foods.append({
                "name": name,
                "count": qf.get("count") or 1,
                "countUnit": qf.get("countUnit") or "",
                "bbox": bbox,
                "qwen": qf,
                "source": "qwen",
            })
        yolo_foods = [y for y in yolo_items if y.get("kind") == "food"]
        for yf in yolo_foods:
            box = yf["box"]
            if any(f["bbox"] and iou(f["bbox"], box) > 0.25 for f in foods):
                continue
            foods.append({
                "name": yf["name"], "count": 1, "countUnit": "个",
                "bbox": list(box), "qwen": None, "source": "yolo",
            })
        return foods

    def _qwen_bbox(self, bbox, w, h):
        if not bbox or len(bbox) != 4:
            return None
        try:
            x1, y1, x2, y2 = [float(v) for v in bbox]
        except (TypeError, ValueError):
            return None
        if max(x1, y1, x2, y2) <= 1.5:  # 0-1 归一化
            x1, y1, x2, y2 = x1 * 1000, y1 * 1000, x2 * 1000, y2 * 1000
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        box = [x1 / 1000.0 * w, y1 / 1000.0 * h, x2 / 1000.0 * w, y2 / 1000.0 * h]
        if box[2] - box[0] < 4 or box[3] - box[1] < 4:
            return None
        return box

    def _build_refs(self, qwen_refs, yolo_items, w, h, food_boxes=None):
        refs = []
        food_boxes = food_boxes or []
        for r in qwen_refs:
            box = self._qwen_bbox(r.get("bbox"), w, h)
            if not box:
                continue
            name = str(r.get("name") or "参照物")
            size = r.get("typicalSizeCm")
            try:
                size = float(size)
            except (TypeError, ValueError):
                size = None
            if not size or size < 2 or size > 200:
                continue
            size = clamp_ref_size(name, size)
            conf = 0.78
            # 参照物框与食物框几乎重合 => 模型把食物框当成了餐具框，尺寸不可信
            if food_boxes and max(iou(box, fb) for fb in food_boxes) > 0.85:
                size = REF_TYPICAL_MID.get(
                    next((k for k in REF_TYPICAL_MID if k in name), ""), size)
                conf = 0.5
            measure = "length" if any(k in name for k in ("筷", "勺", "刀", "叉", "笔", "吸管")) else "diameter"
            refs.append({"name": name, "box": box, "size_cm": size, "measure": measure, "conf": conf})
        yolo_refs = []
        for y in yolo_items:
            if y.get("kind") == "reference":
                yolo_refs.append({"name": y["name"], "box": list(y["box"]),
                                  "size_cm": y["size_cm"], "measure": y.get("measure", "diameter")})
        # 合并同一物体的参照物：YOLO 框更准，Qwen 给的尺寸更贴近中式餐具
        used = set()
        merged = []
        for y in yolo_refs:
            best_i, best_iou = -1, 0.2
            for i, q in enumerate(refs):
                if i in used:
                    continue
                v = iou(y["box"], q["box"])
                if v > best_iou:
                    best_i, best_iou = i, v
            if best_i >= 0:
                q = refs[best_i]
                used.add(best_i)
                merged.append({"name": q["name"], "box": y["box"],
                               "size_cm": q["size_cm"], "measure": q["measure"]})
            else:
                merged.append(y)
        for i, q in enumerate(refs):
            if i not in used:
                merged.append(q)
        return merged

    # ---------- 组合饭/面合并 ----------
    RICE_KEYWORDS = ("米饭", "白饭", "杂粮饭", "糙米饭", "蒸饭", "面条", "拉面", "面")
    DRINK_KEYWORDS = ("可乐", "雪碧", "汽水", "汁", "茶", "咖啡", "啤酒", "红酒", "白酒",
                      "矿泉水", "水", "豆浆", "牛奶", "酸奶", "奶茶", "饮料")

    @classmethod
    def _is_staple(cls, name):
        return any(k in str(name) for k in cls.RICE_KEYWORDS)

    @classmethod
    def _is_drink(cls, name):
        return any(k in str(name) for k in cls.DRINK_KEYWORDS)

    def _in_one_container(self, foods, refs):
        """所有食物是否都在同一个碗/盘/盒里（组合饭特征）。"""
        boxes = [f["bbox"] for f in foods if f.get("bbox")]
        if len(boxes) < 2:
            return False
        for r in refs:
            if r.get("measure") != "diameter":
                continue
            if not any(k in str(r.get("name", "")) for k in ("碗", "盘", "碟", "盒", "锅")):
                continue
            x1, y1, x2, y2 = r["box"]
            inside = 0
            for b in boxes:
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                if x1 - 5 <= cx <= x2 + 5 and y1 - 5 <= cy <= y2 + 5:
                    inside += 1
            if inside >= max(2, int(0.8 * len(boxes))):
                return True
        return False

    def _derive_combo_name(self, foods):
        """没给出整体菜名时，按主菜+主食推导，如 卤鸭腿+白米饭 -> 卤鸭腿饭。"""
        staples = [f for f in foods if self._is_staple(f["name"])]
        others = [f for f in foods if not self._is_staple(f["name"]) and not self._is_drink(f["name"])]

        def qwen_grams(f):
            q = f.get("qwen") or {}
            try:
                return float(q.get("portionGrams") or 0)
            except (TypeError, ValueError):
                return 0.0

        main = max(others, key=qwen_grams) if others else None
        if main and staples:
            n = str(main["name"])
            return n if n.endswith(("饭", "面", "粉")) else n + "饭"
        if main:
            return str(main["name"]) + "套餐"
        return "拼盘"

    def _combo_name(self, foods, qwen_result, refs):
        """判断是否为组合饭/面并给出整体菜名；否则返回 None。"""
        if len(foods) < 2:
            return None
        dish_type = str(qwen_result.get("dishType") or "").strip().lower()
        summary = str(qwen_result.get("summaryName") or "").strip()
        if dish_type == "combo":
            return summary or self._derive_combo_name(foods)
        if dish_type in ("single", "multi"):
            return None
        # Qwen 未给 dishType 时兜底：有主食 + 3项以上 + 都在同一个容器里
        if len(foods) >= 3 and any(self._is_staple(f["name"]) for f in foods) \
                and self._in_one_container(foods, refs):
            return self._derive_combo_name(foods)
        return None

    @staticmethod
    def _merge_combo(foods, name):
        keys = ("portion", "calories", "protein", "fat", "carbs", "sugar", "fiber", "sodium")
        tot = {k: sum(float(f.get(k) or 0) for f in foods) for k in keys}
        grams = max(1.0, tot["portion"])
        per100g = {k: round(tot[k] / grams * 100, 1)
                   for k in ("protein", "fat", "carbs", "sugar", "fiber", "sodium")}
        per100g["kcal"] = round(tot["calories"] / grams * 100, 1)
        return {
            "name": name,
            "count": 1,
            "countUnit": "份",
            "portion": round(grams, 1),
            "portionUnit": "g",
            "calories": round(tot["calories"], 1),
            "calorieUnit": "kcal",
            "protein": round(tot["protein"], 1),
            "fat": round(tot["fat"], 1),
            "carbs": round(tot["carbs"], 1),
            "sugar": round(tot["sugar"], 1),
            "fiber": round(tot["fiber"], 1),
            "sodium": round(tot["sodium"], 1),
            "per100g": per100g,
            "nutritionSource": "combo:" + "+".join(f.get("nutritionSource", "") for f in foods),
            "confidence": round(max(float(f.get("confidence") or 0) for f in foods), 2),
            "components": [f["name"] for f in foods],
        }

    # ---------- 单食物处理 ----------
    @staticmethod
    def _mask_clipped(mask, box, w, h):
        """判断掩码是否被 bbox 截断：多条边被掩码长段贴住即为截断。"""
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        sub = mask[y1:y2, x1:x2]
        if sub.size == 0:
            return False
        band = 2
        edges = [sub[:band, :].any(axis=0).mean(), sub[-band:, :].any(axis=0).mean(),
                 sub[:, :band].any(axis=1).mean(), sub[:, -band:].any(axis=1).mean()]
        return sum(1 for e in edges if e > 0.4) >= 2

    def _process_food(self, food, refs, yolo_items, small, depth_map, diag, w, h, want_debug):
        name = food["name"]
        box = food["bbox"]
        mask = None
        alpha = None
        mask_score = 0.0
        if box:
            try:
                mask, mask_score, alpha = self.vision.sam2_mask(box)
                # Qwen 框偏紧时 SAM2 掩码会被截断，扩框重分割取更大掩码
                if mask is not None and self._mask_clipped(mask, box, w, h):
                    x1, y1, x2, y2 = box
                    bw, bh = x2 - x1, y2 - y1
                    box2 = [max(0, x1 - 0.2 * bw), max(0, y1 - 0.2 * bh),
                            min(w, x2 + 0.2 * bw), min(h, y2 + 0.2 * bh)]
                    mask2, score2, alpha2 = self.vision.sam2_mask(box2)
                    # 扩框后若面积暴涨(>2.2倍)，多半是把盘子/桌面一起分割了，保留原掩码
                    if mask2 is not None and mask.sum() < mask2.sum() <= 2.2 * mask.sum():
                        mask, mask_score, alpha, box = mask2, score2, alpha2, box2
            except Exception as e:  # noqa: BLE001
                self.log("[engine] SAM2 失败 %s: %s" % (name, e))
        mask_valid = mask is not None
        if mask is None:
            # 没有定位时用整图区域兜底（不可靠，权重降低；不参与抠图）
            mask = np.ones((h, w), dtype=bool)
            alpha = None
            box = [w * 0.1, h * 0.1, w * 0.9, h * 0.9]

        # 尺度
        yolo_refs = [y for y in yolo_items if y.get("kind") == "reference"]
        cm_per_px, scale_conf, scale_desc = estimate_scale(box, name, refs, yolo_refs,
                                                           self.db.knowledge, diag)
        # 参照物框（用于深度标定）
        ref_box = None
        if refs:
            fcx, fcy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            refs_sorted = sorted(refs, key=lambda r: (
                ((r["box"][0] + r["box"][2]) / 2 - fcx) ** 2 +
                ((r["box"][1] + r["box"][3]) / 2 - fcy) ** 2))
            ref_box = refs_sorted[0]["box"]

        thickness, measured, thick_note = estimate_thickness(
            depth_map, mask, box, ref_box, cm_per_px, name, self.db.knowledge)

        # 容器面积上限：食物投影面积不可能超过其所在盘/碗的面积
        area_cap_cm2 = None
        for r in refs:
            rx1, ry1, rx2, ry2 = r["box"]
            fcx, fcy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            if rx1 - 5 <= fcx <= rx2 + 5 and ry1 - 5 <= fcy <= ry2 + 5 and r.get("measure") == "diameter":
                # 盘子里食物不会铺满到盘沿；碗里可以更满
                ratio = 0.65 if any(k in str(r.get("name", "")) for k in ("盘", "碟")) else 0.85
                cap = ratio * 3.14159265 / 4.0 * float(r["size_cm"]) ** 2
                area_cap_cm2 = cap if area_cap_cm2 is None else min(area_cap_cm2, cap)

        unit_weight = self._unit_weight(name, food.get("countUnit"))
        grams, detail = estimate_mass(food, mask, depth_map, self.db.knowledge,
                                      (cm_per_px, scale_conf, scale_desc),
                                      (thickness, measured, thick_note), unit_weight,
                                      area_cap_cm2=area_cap_cm2)

        # 营养：优先配方/成分表，未知才用 Qwen 先验
        per100g, source, nconf = self.db.per100g_for(name, food.get("qwen"))

        factor = grams / 100.0
        item = {
            "name": name,
            "count": food.get("count") or 1,
            "countUnit": food.get("countUnit") or "份",
            "portion": round(grams, 1),
            "portionUnit": "g",
            "calories": round(per100g.get("kcal", 0) * factor, 1),
            "calorieUnit": "kcal",
            "protein": round(per100g.get("protein", 0) * factor, 1),
            "fat": round(per100g.get("fat", 0) * factor, 1),
            "carbs": round(per100g.get("carbs", 0) * factor, 1),
            "sugar": round(per100g.get("sugar", 0) * factor, 1),
            "fiber": round(per100g.get("fiber", 0) * factor, 1),
            "sodium": round(per100g.get("sodium", 0) * factor, 1),
            "per100g": {k: round(v, 1) for k, v in per100g.items()},
            "nutritionSource": source,
            "confidence": round(min(0.95, 0.5 * nconf + 0.3 * scale_conf + 0.2 * mask_score), 2),
        }
        if want_debug:
            item["debug"] = detail
            item["maskScore"] = round(mask_score, 3)
        return item, (alpha if (mask_valid and alpha is not None) else None)

    @staticmethod
    def _guided_filter(guide_gray, src, radius=5, eps=1e-4):
        """导向滤波：让 alpha 边缘贴合图像边缘（手写实现，无需 ximgproc）。"""
        g = guide_gray.astype(np.float32) / 255.0
        p = src.astype(np.float32)
        k = (radius * 2 + 1, radius * 2 + 1)
        mean_g = cv2.boxFilter(g, -1, k)
        mean_p = cv2.boxFilter(p, -1, k)
        cov_gp = cv2.boxFilter(g * p, -1, k) - mean_g * mean_p
        var_g = cv2.boxFilter(g * g, -1, k) - mean_g * mean_g
        a = cov_gp / (var_g + eps)
        b = mean_p - a * mean_g
        return cv2.boxFilter(a, -1, k) * g + cv2.boxFilter(b, -1, k)

    def _refine_alpha(self, image_bgr, union):
        """SAM2 软掩码边缘精修：导向滤波 + smoothstep + 内部不透明。"""
        guide = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        refined = self._guided_filter(guide, union.astype(np.float32) / 255.0)
        lo, hi = 0.30, 0.70
        t = np.clip((refined - lo) / (hi - lo), 0.0, 1.0)
        smooth = t * t * (3.0 - 2.0 * t)
        out = np.clip(smooth * 255.0, 0, 255).astype(np.uint8)
        core = cv2.erode((union > 220).astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1)
        out[core > 0] = 255
        return out

    def _fetch_u2net_alpha(self, image_bgr):
        """调用本机 U2NET 抠图服务，取回软掩码（用于提供更自然的边缘）。"""
        import urllib.request

        url = os.environ.get("U2NET_MASK_URL", "http://127.0.0.1:5001/remove-bg?only_mask=1&quality=standard")
        try:
            ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if not ok:
                return None
            boundary = "----foodai"
            body = (
                ("--%s\r\n" % boundary).encode()
                + b'Content-Disposition: form-data; name="image"; filename="food.jpg"\r\n'
                + b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
                + ("--%s--\r\n" % boundary).encode()
            )
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "multipart/form-data; boundary=" + boundary})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            arr = np.frombuffer(raw, dtype=np.uint8)
            mask = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
            if mask is None:
                return None
            h, w = image_bgr.shape[:2]
            if mask.shape != (h, w):
                mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)
            _debug_save("last_u2net_mask.png", mask)
            return mask
        except Exception as e:  # noqa: BLE001
            self.log("[cutout] U2NET 掩码获取失败: %s" % e)
            return None

    def _compose_cutout(self, image_bgr, alphas, u2net_alpha=None, key_alpha=None,
                        color_bgr=None):
        """合成抠图：U2NET 出边缘，SAM2 补上 U2NET 漏掉的菜，纯色底 key 补上餐具，裁边后最大边 640。

        掩码按换底图计算（背景干净、分割更稳），但 RGB 用换底前的原图（color_bgr），
        避免编辑模型把白色/玻璃餐具染成背景色导致抠图里餐具"消失"。
        """
        if not alphas and key_alpha is None:
            return None
        if color_bgr is not None and color_bgr.shape[:2] == image_bgr.shape[:2]:
            rgb_src = color_bgr
        else:
            rgb_src = image_bgr
        h, w = image_bgr.shape[:2]
        union = np.zeros((h, w), dtype=np.uint8)
        for a in alphas:
            if a is None:
                continue
            aa = a if a.shape == (h, w) else cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
            union = np.maximum(union, aa)
        if int((union > 30).sum()) < 100 and key_alpha is None:
            return None

        if u2net_alpha is None:
            alpha = self._refine_alpha(image_bgr, union)
        else:
            # 找出 U2NET 没抠到的菜（其 SAM2 区域内 U2NET 掩码很低）
            missing = []
            for a in alphas:
                if a is None:
                    continue
                aa = a if a.shape == (h, w) else cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
                core = cv2.erode((aa > 200).astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1)
                if int(core.sum()) <= 0:
                    continue
                coverage = float(u2net_alpha[core > 0].mean()) / 255.0
                if coverage < 0.4:
                    missing.append(aa)
            alpha = u2net_alpha.copy()
            if missing:
                miss_union = np.zeros((h, w), dtype=np.uint8)
                for m in missing:
                    miss_union = np.maximum(miss_union, m)
                miss_refined = self._refine_alpha(image_bgr, miss_union)
                alpha = np.maximum(alpha, miss_refined)
            # 已识别菜的内部强制不透明，防止 U2NET 漏检造成空洞
            core_all = cv2.erode((union > 200).astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1)
            alpha[core_all > 0] = 255

        # 纯色底 key 并入：把 U2NET 不认的餐具（白碗/玻璃碗）和勺子一起保留
        if key_alpha is not None:
            key_refined = self._refine_alpha(image_bgr, key_alpha)
            alpha = np.maximum(alpha, key_refined)

        # 填补被前景包围的空洞：避免出现"只抠出盘子圈、中间食物透明"的情况
        binm = (alpha > 100).astype(np.uint8)
        padded = np.pad(binm, 1, mode="constant", constant_values=0)
        ff = padded.copy()
        ff_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
        cv2.floodFill(ff, ff_mask, (0, 0), 1)
        holes = ((ff == 0) & (padded == 0))[1:-1, 1:-1].astype(np.uint8) * 255
        if holes.any():
            alpha = np.maximum(alpha, holes)

        ys, xs = np.where(alpha > 30)
        if len(xs) == 0:
            return None
        if os.environ.get("FOOD_AI_CUTOUT_DEBUG"):
            self.log("[cutout-debug] img=%s key=%s u2net=%s union=%.3f key_ref=%.3f alpha=%.3f bbox=(%d,%d,%d,%d)" % (
                image_bgr.shape[:2],
                None if key_alpha is None else key_alpha.shape,
                None if u2net_alpha is None else u2net_alpha.shape,
                (union > 30).mean(),
                (key_refined > 30).mean() if key_alpha is not None else -1,
                (alpha > 30).mean(),
                xs.min(), ys.min(), xs.max(), ys.max()))
        x1, x2 = int(xs.min()), int(xs.max())
        y1, y2 = int(ys.min()), int(ys.max())
        margin = int(max(x2 - x1, y2 - y1) * 0.06)
        x1, y1 = max(0, x1 - margin), max(0, y1 - margin)
        x2, y2 = min(w, x2 + margin), min(h, y2 + margin)
        rgba = np.dstack([rgb_src[y1:y2, x1:x2], alpha[y1:y2, x1:x2]])
        scale = min(1.0, 640.0 / max(rgba.shape[0], rgba.shape[1]))
        if scale < 1.0:
            rgba = cv2.resize(rgba, (max(1, int(rgba.shape[1] * scale)), max(1, int(rgba.shape[0] * scale))),
                              interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", rgba)
        if not ok:
            return None
        _debug_save("last_cutout.png", buf.tobytes())
        return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()

    def _unit_weight(self, name, count_unit):
        table = self.db.knowledge["unit_weights_g"]
        unit = normalize(str(count_unit or ""))
        default_units = table.get("default", {})
        for key, mapping in table.items():
            if key.startswith("_") or key == "default":
                continue
            if key in name:
                if unit and unit in mapping:
                    return mapping[unit]
                if not unit and mapping:
                    return next(iter(mapping.values()))
                break
        if unit and unit in default_units:
            return default_units[unit]
        return None
