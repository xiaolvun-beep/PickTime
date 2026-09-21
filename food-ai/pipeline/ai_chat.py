# -*- coding: utf-8 -*-
"""添加页「询问 AI」：Doubao（火山方舟 Ark）流式对话。

用户打开弹窗后可以：发食物图片重新识别，或按识别到的食物名说吃了多少克、
发包装上的营养成分表，AI 核对后把名称 / 热量 / 六项营养填回添加弹窗。

环境变量：
  ARK_API_KEY          服务端火山方舟密钥
  ARK_BASE_URL         Ark OpenAI 兼容接入地址，默认 https://ark.cn-beijing.volces.com/api/v3
  DOUBAO_CHAT_MODEL    模型或接入点 ID，默认 doubao-seed-2.1-pro
  DOUBAO_CHAT_TIMEOUT  单次超时秒数，默认 120
  DOUBAO_THINKING      深度思考开关：disabled（默认，回复快）/ enabled / auto
"""
import json
import os
import time
import urllib.error
import urllib.request

ARK_BASE_URL = (os.environ.get("ARK_BASE_URL") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
CHAT_URL = ARK_BASE_URL + "/chat/completions"
API_KEY = os.environ.get("ARK_API_KEY", "")
MODEL = os.environ.get("DOUBAO_CHAT_MODEL", "doubao-seed-2.1-pro")
THINKING = (os.environ.get("DOUBAO_THINKING") or "disabled").strip().lower()

LANG_NAMES = {"zh-CN": "中文", "en": "English", "ja": "日本語", "ko": "한국어"}

SYSTEM_TMPL = """你是「拾光」App 的食物数据助手，帮用户核对这份食物的名称、热量和营养数据。

弹窗当前数据：
- 食物名称：__NAME__
- 热量：__KCAL__ kcal；蛋白 __PROTEIN__g、脂肪 __FAT__g、碳水 __CARBS__g、糖 __SUGAR__g、纤维 __FIBER__g、钠 __SODIUM__mg。
- __PORTION__ 大于 0 时，以上数值对应 __PORTION__ 克；等于 0 时，以上数值只是最初整份估算，克数未知。

用户通常有两种诉求，请自然应对：
一、用户发来食物图片：识别图片里的食物，告诉用户食物名称、总热量（kcal）和六项营养（蛋白/脂肪/碳水/糖/纤维/钠），并问用户是否确认上传到添加页。必须完全根据图片内容重新识别食物、份量和营养，给出你自己的判断值，不要照抄弹窗当前值；如果与弹窗当前值差异较大，简单说明以你重新识别的结果为准。
二、用户对当前这份食物的数据有疑问：请用户告诉你吃了多少克，以及有没有包装上的营养成分表。
- 用户发来营养成分表图片：读出每 100g 的能量与营养，按实际吃的克数换算成实际食用量，告诉用户新数据并问是否确认上传。
- 营养成分表上没有标注的项目（例如没有糖或膳食纤维）：不要直接按 0 填写，要明确告诉用户「这张表里没有标注糖/膳食纤维」，并按同类食物的常见值给出估算值，确认后一起填入。
- 用户只说了克数、没有营养成分表：按这类食物常见每 100g 数值估算（要说明是估算），告诉用户新数据并问是否确认上传；这一句询问里必须带上：「我未能看到营养价值表，如果方便的话，把包装上的营养成分表发给我，综合识别后的数据会更准，然后再上传。」
- 用户只发了营养成分表没说克数：先读出每 100g 数值，再问用户吃了多少克。

确认与上传：
- 只有在你刚刚给出完整数据、并明确询问是否上传之后，用户明确表达上传意愿（例如「确认上传」「确认」「上传吧」「帮我填到添加页」「就按这个填」）时，才输出一行修正标记，把数据填进添加弹窗：
[[FIX]]{"name":"食物名称","kcal":120,"protein":2.1,"fat":5.6,"carbs":18.2,"sugar":9.1,"fiber":0.8,"sodium":120,"portion":30}[[/FIX]]
- 用户只是回应「好的」「嗯」「收到」「谢谢」「可以」「行」等语气词时，一律不算确认上传，绝对不要输出修正标记，最多再问一句「需要我帮你填到添加页吗？」。
- 用户还没明确表达上传意愿前，绝对不要输出修正标记。
- 标记内是实际食用量的总量；portion 是实际吃的克数；能量单位是 kJ 时换算 kcal 除以 4.184；sodium 单位 mg，其余为 g。
- name 用中文食物名；名称没有变化时可以省略 name。
- 输出标记后，用一句话确认即可（例如「已经帮你填到添加页啦～」），不要在标记外再重复数值清单。

回复要求：
- 用用户使用的语言回复；用户只发了图片没有文字时，用 __LANG__ 回复。
- 回复简短、口语化，一次说清食物名称、热量和六项营养；不要用 Markdown 列表，不要长篇大论。"""


def build_system(context):
    ctx = context or {}

    def num(v, digits=1):
        try:
            return round(float(v), digits)
        except (TypeError, ValueError):
            return 0

    lang = str(ctx.get("lang") or "zh-CN")
    return (SYSTEM_TMPL
            .replace("__NAME__", str(ctx.get("name") or "这份食物")[:40])
            .replace("__PORTION__", str(num(ctx.get("portion"), 0)))
            .replace("__KCAL__", str(num(ctx.get("kcal"), 0)))
            .replace("__PROTEIN__", str(num(ctx.get("protein"))))
            .replace("__FAT__", str(num(ctx.get("fat"))))
            .replace("__CARBS__", str(num(ctx.get("carbs"))))
            .replace("__SUGAR__", str(num(ctx.get("sugar"))))
            .replace("__FIBER__", str(num(ctx.get("fiber"))))
            .replace("__SODIUM__", str(num(ctx.get("sodium"), 0)))
            .replace("__LANG__", LANG_NAMES.get(lang, "中文")))


def _open_stream(req, timeout):
    """打开 Ark 流式连接；模型开通同步中偶发 ModelNotOpen/5xx 时自动重试。"""
    last_err = None
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:  # noqa: BLE001
                detail = ""
            last_err = RuntimeError("Ark 接口错误(%s): %s" % (e.code, detail or e.reason))
            transient = e.code in (404, 408, 429, 500, 502, 503, 504) or "ModelNotOpen" in detail
            if not transient or attempt >= 2:
                raise last_err
        except urllib.error.URLError as e:
            last_err = RuntimeError("Ark 网络错误: %s" % e)
            if attempt >= 2:
                raise last_err
        time.sleep(0.8 * (attempt + 1))
    raise last_err


def _last_user_has_image(messages):
    for m in reversed(list(messages or [])):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, list):
            return any(isinstance(p, dict) and p.get("type") == "image_url" for p in content)
        return False
    return False


def stream_chat(messages, context, timeout=None, api_key=None):
    """向火山方舟发起流式对话，逐段 yield 文本增量。"""
    key = str(api_key or API_KEY or "").strip()
    if not key:
        raise RuntimeError("未配置 ARK_API_KEY")
    timeout = timeout or int(os.environ.get("DOUBAO_CHAT_TIMEOUT", "120"))
    system = build_system(context)
    if _last_user_has_image(messages):
        system += ("\n\n注意：用户本轮发来了图片，请完全根据图片内容重新识别食物名称、份量和营养，"
                   "给出你自己的估算值，不要照抄弹窗当前值。")
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}] + list(messages or []),
        "stream": True,
        "temperature": 0.2,
        "max_tokens": 1200,
    }
    if THINKING in ("enabled", "disabled", "auto"):
        body["thinking"] = {"type": THINKING}
    req = urllib.request.Request(
        CHAT_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    resp = _open_stream(req, timeout)
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                data = json.loads(payload)
            except Exception:  # noqa: BLE001
                continue
            choices = data.get("choices") or []
            if not choices:
                continue
            delta = (choices[0].get("delta") or {}).get("content")
            if delta:
                yield delta


TIP_SYSTEM_TMPL = """你是「拾光」App 的可爱美食小助手。用户会发来一张食物的抠图照片，请你：
1. 先在心里判断这是什么食物（看不出来就按最接近的品类判断，不要反问用户）；
2. 再写一段可爱、温暖、口语化的小贴士（60~100 个字，2~3 句话）：可以说口感、搭配、吃法、营养小知识，或者一句暖心的话，读起来像朋友在耳边轻声提醒。
只输出小贴士正文：不要标题、不要引号、不要 Markdown、不要表情符号、不要解释，也不要重复食物名称。用 __LANG__ 回复。"""


def generate_tip(image_data_url, name="", lang="zh-CN", timeout=None, api_key=None):
    """看抠图照片判断食物，生成一句可爱温馨的小贴士。"""
    key = str(api_key or API_KEY or "").strip()
    if not key:
        raise RuntimeError("未配置 ARK_API_KEY")
    timeout = timeout or int(os.environ.get("DOUBAO_CHAT_TIMEOUT", "120"))
    system = TIP_SYSTEM_TMPL.replace("__LANG__", LANG_NAMES.get(lang, "中文"))
    hint = ("图片里的食物是「%s」，请自己看图确认。" % name) if name else ""
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_data_url}},
                {"type": "text", "text": hint + "请判断这是什么食物，并给出小贴士。"},
            ]},
        ],
        "stream": False,
        "temperature": 0.7,
        "max_tokens": 260,
    }
    if THINKING in ("enabled", "disabled", "auto"):
        body["thinking"] = {"type": THINKING}
    req = urllib.request.Request(
        CHAT_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    resp = _open_stream(req, timeout)
    with resp:
        data = json.loads(resp.read().decode("utf-8", "ignore"))
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("Ark 未返回结果")
    text = str(((choices[0].get("message") or {}).get("content")) or "").strip()
    if not text:
        raise RuntimeError("Ark 返回为空")
    return text
