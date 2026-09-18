# -*- coding: utf-8 -*-
"""第一步：Qwen-VL 识别「是什么」。

职责边界（与流程树一致）：
  - 识别食物名称、数量、生活单位
  - 给出粗定位 bbox（0-1000 归一化）供 YOLO/SAM2 使用
  - 给出餐具等参照物 bbox，用于像素->厘米标定
  - 给出每100g营养的“先验估计”（仅当营养库无法匹配时兜底）
不负责最终热量计算。
"""
import base64
import json
import os
import re
import time
import urllib.request

DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
# API Key 只放在服务端环境变量（pm2 ecosystem.config.js 的 env 中），不再出现在前端
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
MODEL = os.environ.get("QWEN_VL_MODEL", "qwen3-vl-flash")

PROMPT = """你是营养识别助手。请先逐个检查图片中的所有可见食物和饮料（含重复出现的同类食物），只返回 JSON，不要输出任何多余文字。

返回格式：
{"dishType":"single|combo|multi","summaryName":"","foods":[{"name":"中文食物名","count":1,"countUnit":"个","bbox":[x1,y1,x2,y2],"portionGrams":200,"kcalPer100g":350,"proteinPer100g":10,"fatPer100g":20,"carbsPer100g":30,"sugarPer100g":5,"fiberPer100g":2,"sodiumPer100g":400,"confidence":0.9}],"references":[{"name":"盘子","bbox":[x1,y1,x2,y2],"typicalSizeCm":25}]}

dishType 判断（重要）：
- single：图片里只有一种食物。
- combo：一份"组合饭/组合面/套餐"（米饭或面条和多种配菜装在同一碗/盘/盒里，整体是一道菜），例如鸭腿饭、鸡腿饭、卤肉饭、猪脚饭、咖喱鸡饭、西红柿鸡蛋面、牛肉面。此时 foods 里仍按可见组成分别列出（如白米饭、卤鸭腿、卤蛋），但 summaryName 必须给整体菜名（如"鸭腿饭""西红柿鸡蛋面"）。
- multi：多个独立餐盘的多菜场景（各自是独立的菜）。
summaryName：dishType=combo 时给整体菜名，其他情况返回空字符串。判断原则与人类习惯一致：一份鸭腿饭叫"鸭腿饭"，不会叫"米饭+鸭腿+卤蛋"。

要求：
1. bbox 为 0-1000 归一化整数坐标 [左,上,右,下]，必须紧贴该食物可见范围；重复食物合并为一项并用 count 统计。
2. countUnit 用中文生活单位（个/杯/瓶/碗/份/盘/块/片/根/串等）。
3. portionGrams 是该食物总重量（克）的粗估。
4. kcalPer100g 等每100g营养值为你的知识先验，没有把握也要给合理值，不能省略；sodium 单位 mg，其余为 g。
5. references 是图中可作尺寸参照的餐具或常见物体（盘子/碗/杯/筷子/勺/刀叉/瓶/易拉罐/手等），typicalSizeCm 为其典型尺寸（厘米，盘子取直径、筷子取长度）。请按图中实际大小在常见规格内取值：小碗12-14、大碗18-22、盘子20-24、碟子14-16、杯子7-9、易拉罐6.5、筷子25，不要一律取最大值。没有参照物就返回空数组。
6. 只识别真正可食用的食物和饮料；餐巾纸、装饰花、蜡烛、包装盒等不算食物，不要输出。
7. 有包装的食品/饮料必须读取包装上的文字（品牌、品名、口味）后再判断，避免把啤酒认成可乐。
8. 完全无法识别时返回 {"foods":[],"references":[]}。"""


def _repair_truncated_json(text):
    """输出被 max_tokens 截断时，保留最后一个完整对象并补全括号。"""
    start = text.find("{")
    if start < 0:
        return None
    body = text[start:]
    idx = body.rfind("}")
    while idx > 0:
        candidate = body[:idx + 1]
        stack = []
        in_str = False
        esc = False
        balanced = True
        for ch in candidate:
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch in "{[":
                stack.append(ch)
            elif ch in "}]":
                if not stack:
                    balanced = False
                    break
                op = stack.pop()
                if (op == "{" and ch != "}") or (op == "[" and ch != "]"):
                    balanced = False
                    break
        if balanced and not in_str:
            closers = "".join("}" if op == "{" else "]" for op in reversed(stack))
            try:
                obj = json.loads(candidate + closers)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                pass
        idx = body.rfind("}", 0, idx)
    return None


def _extract_json(text):
    text = str(text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return _repair_truncated_json(text)


def recognize(image_bytes, mime="image/jpeg", timeout=90, api_key=None):
    """调用 Qwen-VL，返回 (result_dict, elapsed_seconds, raw_text)。

    api_key: 用户自带的 DashScope Key（由账号服务注入）；为空时使用服务端环境变量。
    """
    key = str(api_key or API_KEY or "").strip()
    if not key:
        raise RuntimeError("未配置 DASHSCOPE_API_KEY")
    b64 = base64.b64encode(image_bytes).decode()
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "你是严谨的食物视觉识别助手，只输出 JSON。"},
            {"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, b64)}},
            ]},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "max_tokens": 1800,
    }
    req = urllib.request.Request(
        DASHSCOPE_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    elapsed = time.time() - t0
    usage = data.get("usage") or {}
    print("[qwen] model=%s usage=%s elapsed=%.1fs" % (
        MODEL, json.dumps(usage, ensure_ascii=False), elapsed), flush=True)
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    parsed = _extract_json(content) or {}
    foods = parsed.get("foods")
    refs = parsed.get("references")
    if not isinstance(foods, list):
        foods = []
    if not isinstance(refs, list):
        refs = []
    dish_type = str(parsed.get("dishType") or "").strip().lower()
    summary = str(parsed.get("summaryName") or "").strip()
    return {"foods": foods, "references": refs, "dishType": dish_type,
            "summaryName": summary}, elapsed, content
