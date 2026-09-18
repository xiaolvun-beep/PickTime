# -*- coding: utf-8 -*-
"""食物名称多语言翻译（供展示用，不改动记录里的原始名称）。

- 用 qwen-flash 文本模型批量翻译，结果落盘缓存，重复请求不消耗额度
- 支持 en / ja / ko / zh-CN
"""
import json
import os
import re
import threading
import urllib.request

from .qwen import API_KEY

DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = os.environ.get("QWEN_TEXT_MODEL", "qwen-flash")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_FILE = os.path.join(BASE, "data", "food_i18n_cache.json")

LANG_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "zh-CN": "Simplified Chinese",
}

_lock = threading.Lock()
_cache = None


def _load_cache():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}
    return _cache


def _save_cache():
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_cache, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


# 目标语言必须出现的文字范围（防止模型输出英文）
_SCRIPT_RE = {
    "ja": re.compile(r"[\u3040-\u30ff\u3400-\u9fff]"),
    "ko": re.compile(r"[\uac00-\ud7af]"),
}


def _script_ok(text, lang):
    pat = _SCRIPT_RE.get(lang)
    if not pat:
        return True
    return bool(pat.search(str(text or "")))


def _call_qwen(texts, lang, strict=False):
    extra = ""
    if strict:
        extra = ("\n特别注意：必须完全使用%s书写（日语用汉字/假名，外来语写片假名；"
                 "韩语用谚文），绝对不要出现任何英文单词。" % LANG_NAMES.get(lang, lang))
    examples = {
        "en": "（例如 鸭腿饭→Braised Duck Leg Rice、西红柿鸡蛋面→Tomato and Egg Noodles）",
        "ja": "（例如 鸭腿饭→鴨肉ごはん、西红柿鸡蛋面→トマトと卵の麺、蛋糕→ケーキ）",
        "ko": "（例如 鸭腿饭→오리다리밥、西红柿鸡蛋面→토마토 계란 국수、蛋糕→케이크）",
        "zh-CN": "（例如 Duck Leg Rice→鸭腿饭）",
    }.get(lang, "")
    prompt = (
        "把下面的中文内容（食物名称或用餐备注，可能是一句短话）翻译成%s。要求：译文简洁、地道、"
        "符合当地表达习惯%s。只返回 JSON 对象，键为原文，值为译文，不要输出任何多余文字。%s\n%s"
        % (LANG_NAMES.get(lang, lang), examples, extra, json.dumps(texts, ensure_ascii=False))
    )
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }
    req = urllib.request.Request(
        DASHSCOPE_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + API_KEY},
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        data = json.load(resp)
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = re.sub(r"^```(?:json)?\s*", "", str(content).strip())
    content = re.sub(r"\s*```$", "", content)
    try:
        parsed = json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        parsed = json.loads(m.group(0)) if m else {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items() if k and v}


_SPLIT_RE = re.compile(r"[、,，;；/]+")


def _valid_translation(src, dst, lang):
    """译文有效：非空、语言正确、且确实发生了翻译（不是原样返回）。"""
    if not dst:
        return False
    if str(dst).strip() == str(src).strip():
        return False
    return _script_ok(dst, lang)


def translate_names(texts, lang):
    """返回 {原文: 译文}；命中缓存的直接返回，未命中的批量请求后缓存。

    多道菜拼接的长名字（如"白米饭、卤鸭腿、…"）会先按分隔符拆开逐项翻译，
    再按目标语言习惯拼装，避免长文本翻译失败/截断导致查不到译文。
    """
    lang = str(lang or "en")
    texts = [str(t).strip() for t in (texts or []) if str(t).strip()]
    if not texts or lang not in LANG_NAMES:
        return {}

    # 拆分组合菜名
    split_map = {}
    atoms = set()
    for t in texts:
        parts = [p.strip() for p in _SPLIT_RE.split(t) if p.strip()]
        if len(parts) > 1:
            split_map[t] = parts
            atoms.update(parts)
        else:
            atoms.add(t)
    atom_list = list(atoms)

    with _lock:
        cache = _load_cache()
        lang_cache = cache.setdefault(lang, {})
        result_atoms = {t: lang_cache[t] for t in atom_list if t in lang_cache}
        missing = [t for t in atom_list if t not in lang_cache]

    if missing:
        # 每批最多 40 个，避免单次请求过大
        for i in range(0, len(missing), 40):
            chunk = missing[i:i + 40]
            try:
                translated = _call_qwen(chunk, lang)
            except Exception:
                translated = {}
            # 不合格（原样返回/语言错误）的条目用严格模式重试一次
            bad = [k for k in chunk if translated.get(k) and not _valid_translation(k, translated[k], lang)]
            if bad:
                try:
                    retry = _call_qwen(bad, lang, strict=True)
                except Exception:
                    retry = {}
                for k in bad:
                    if _valid_translation(k, retry.get(k), lang):
                        translated[k] = retry[k]
            with _lock:
                for k in chunk:
                    v = translated.get(k)
                    if _valid_translation(k, v, lang):
                        lang_cache[k] = v
                        result_atoms[k] = v
                _save_cache()

    # 组装：单条直接用译文；组合菜名逐项拼装
    result = {}
    for t in texts:
        if t in split_map:
            sep = "、" if lang == "ja" else ", "
            result[t] = sep.join(result_atoms.get(p, p) for p in split_map[t])
        elif t in result_atoms:
            result[t] = result_atoms[t]
    return result
