#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""食物拍照识别服务（后端识别流程）。

监听 127.0.0.1:5003，由 nginx 将 /api/recognize 转发进来。
对外返回结构与 DashScope(OpenAI 兼容) 一致，前端解析逻辑无需改动：
  {"choices":[{"message":{"content":"{\\"foods\\":[...]}"}}]}

启动：
  source /home/ubuntu/yolo-env/bin/activate
  uvicorn service:app --host 127.0.0.1 --port 5003
"""
import json
import os
import time
import hashlib
import traceback
import asyncio
import threading

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from pipeline import ai_chat
from pipeline.engine import RecognitionEngine, extract_image_from_chat_body
from pipeline.meitu import AuthError
from pipeline.translate import translate_names

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "service.log")


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


app = FastAPI(title="PickTime Food Recognition", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = RecognitionEngine(log=log)
_ready = {"ok": False, "error": None}

# 抠图进度：jobId -> {"stage": str, "ts": float}，供前端轮询展示阶段文案
PROGRESS = {}
PROGRESS_TTL = 600

# 小贴士缓存：sha256(语言|图片) -> {"tip": str, "ts": float}
TIP_CACHE = {}
TIP_CACHE_TTL = 6 * 3600
TIP_CACHE_MAX = 500


def _set_progress(job_id, stage):
    if not job_id:
        return
    now = time.time()
    PROGRESS[job_id] = {"stage": stage, "ts": now}
    if len(PROGRESS) > 200:
        for key in [k for k, v in PROGRESS.items() if now - v["ts"] > PROGRESS_TTL]:
            PROGRESS.pop(key, None)


@app.on_event("startup")
def startup():
    try:
        log("加载模型(YOLO26/SAM2/DepthV2)...")
        engine.load()
        _ready["ok"] = True
        log("模型加载完成，服务就绪")
    except Exception as e:  # noqa: BLE001
        _ready["error"] = str(e)
        log("模型加载失败: %s\n%s" % (e, traceback.format_exc()))


@app.get("/health")
def health():
    return {"ready": _ready["ok"], "error": _ready["error"]}


@app.get("/api/progress")
def progress(jobId: str = ""):
    item = PROGRESS.get(jobId)
    return {"stage": item["stage"] if item else ""}


def _compat_response(foods, extra=None, cutout=None):
    payload_json = {"foods": foods}
    if cutout:
        payload_json["cutout"] = cutout
    content = json.dumps(payload_json, ensure_ascii=False)
    payload = {
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": content},
        }],
        "object": "chat.completion",
        "model": "food-pipeline-v2",
    }
    if extra:
        payload["debug"] = extra
    return JSONResponse(payload)


@app.post("/api/recognize")
async def recognize(request: Request):
    if not _ready["ok"]:
        return JSONResponse({"error": "模型未就绪: %s" % _ready["error"]}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    image_bytes, mime = extract_image_from_chat_body(body)
    if not image_bytes:
        return JSONResponse({"error": "请求中未找到图片"}, status_code=400)
    want_debug = bool(body.get("debug")) if isinstance(body, dict) else False
    job_id = str(body.get("jobId") or "")[:64] if isinstance(body, dict) else ""
    # 账号服务（5002）校验试用期后注入用户自己的 Qwen / 美图 Key；没有则用服务端 Key
    user_api_key = str(request.headers.get("x-dashscope-api-key") or "").strip() or None
    meitu_ak = str(request.headers.get("x-meitu-ak") or "").strip() or None
    meitu_sk = str(request.headers.get("x-meitu-sk") or "").strip() or None
    _set_progress(job_id, "start")
    try:
        # 放到线程池执行，避免同步识别流程阻塞事件循环（否则 /api/progress 轮询会排队）
        result = await asyncio.to_thread(
            engine.recognize, image_bytes, want_debug=want_debug,
            progress=lambda stage: _set_progress(job_id, stage), api_key=user_api_key,
            meitu_ak=meitu_ak, meitu_sk=meitu_sk)
    except Exception as e:  # noqa: BLE001
        log("识别失败: %s\n%s" % (e, traceback.format_exc()))
        return JSONResponse({"error": "识别失败: %s" % e}, status_code=500)
    log("识别完成 %s 用时%s秒 timings=%s" % (
        [f["name"] for f in result["foods"]], result["totalSeconds"], result.get("timings")))
    extra = {
        "totalCalories": result["totalCalories"],
        "timings": result.get("timings"),
        "totalSeconds": result.get("totalSeconds"),
    }
    if result.get("qwenError"):
        extra["qwenError"] = str(result["qwenError"])[:300]
    if result.get("cutoutError") and (meitu_ak or meitu_sk):
        extra["cutoutError"] = result["cutoutError"]
    if want_debug:
        extra["foods"] = result["foods"]
    return _compat_response(result["foods"], extra, cutout=result.get("cutout"))


@app.post("/api/cutout")
async def cutout_only(request: Request):
    """仅抠图（试用期结束后只用美图抠图、热量手动填写的场景）。

    账号服务（5002）校验登录/试用期后，注入用户自己的美图 AK/SK。
    """
    if not _ready["ok"]:
        return JSONResponse({"error": "模型未就绪: %s" % _ready["error"]}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    image_bytes, _mime = extract_image_from_chat_body(body)
    if not image_bytes:
        return JSONResponse({"error": "请求中未找到图片"}, status_code=400)
    meitu_ak = str(request.headers.get("x-meitu-ak") or "").strip() or None
    meitu_sk = str(request.headers.get("x-meitu-sk") or "").strip() or None
    try:
        data_url = await asyncio.to_thread(engine.cutout_only, image_bytes, meitu_ak, meitu_sk)
    except AuthError as e:
        if meitu_ak or meitu_sk:
            log("美图密钥无效: %s" % e)
            return JSONResponse({"error": "美图密钥无效，请重新填写", "code": "MEITU_KEY_INVALID"},
                                status_code=403)
        log("服务端美图密钥异常: %s" % e)
        return JSONResponse({"error": "抠图失败，请重试"}, status_code=502)
    except Exception as e:  # noqa: BLE001
        log("抠图失败: %s\n%s" % (e, traceback.format_exc()))
        return JSONResponse({"error": "抠图失败: %s" % e}, status_code=500)
    if not data_url:
        return JSONResponse({"error": "抠图失败，请重试"}, status_code=502)
    return JSONResponse({"cutout": data_url})


def _clean_chat_messages(raw):
    """只保留文本/图片消息，限制条数与长度。"""
    out = []
    for m in (raw or [])[-12:]:
        if not isinstance(m, dict):
            continue
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = m.get("content")
        if isinstance(content, str):
            text = content.strip()[:2000]
            if text:
                out.append({"role": role, "content": text})
        elif isinstance(content, list):
            parts = []
            for p in content[:4]:
                if not isinstance(p, dict):
                    continue
                if p.get("type") == "text" and p.get("text"):
                    parts.append({"type": "text", "text": str(p["text"])[:2000]})
                elif p.get("type") == "image_url":
                    url = ((p.get("image_url") or {}).get("url") or "")
                    if isinstance(url, str) and url.startswith("data:image/"):
                        parts.append({"type": "image_url", "image_url": {"url": url}})
            if parts:
                out.append({"role": role, "content": parts})
    return out


@app.post("/api/ai-chat")
async def ai_chat_stream(request: Request):
    """添加页「询问 AI」：流式返回（SSE）。"""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    messages = _clean_chat_messages(body.get("messages"))
    if not messages:
        return JSONResponse({"error": "缺少 messages"}, status_code=400)
    context = body.get("context") if isinstance(body.get("context"), dict) else {}

    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def worker():
        try:
            # 「询问 AI」始终使用服务端 Doubao(火山方舟) Key，不注入用户密钥
            for delta in ai_chat.stream_chat(messages, context):
                loop.call_soon_threadsafe(queue.put_nowait, ("delta", delta))
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
        except Exception as e:  # noqa: BLE001
            log("AI对话失败: %s" % e)
            loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)[:200]))

    threading.Thread(target=worker, daemon=True).start()

    async def gen():
        while True:
            kind, payload = await queue.get()
            if kind == "delta":
                yield "data: " + json.dumps({"delta": payload}, ensure_ascii=False) + "\n\n"
            elif kind == "error":
                yield "data: " + json.dumps({"error": payload}, ensure_ascii=False) + "\n\n"
                break
            else:
                yield "data: [DONE]\n\n"
                break

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.post("/api/food-tip")
async def food_tip(request: Request):
    """首页点击抠图的小贴士：看图片判断食物并生成一句可爱提示（无需登录）。"""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    image = body.get("image") if isinstance(body, dict) else None
    if not isinstance(image, str) or not image.startswith("data:image/"):
        return JSONResponse({"error": "缺少图片"}, status_code=400)
    if len(image) > 4 * 1024 * 1024:
        return JSONResponse({"error": "图片过大"}, status_code=413)
    lang = str(body.get("lang") or "zh-CN")[:10]
    # 同一张图 + 同一语言只生成一次：重复打开大图/多个用户看同一张图时直接命中缓存
    cache_key = hashlib.sha256((lang + "|" + image).encode("utf-8")).hexdigest()
    now = time.time()
    hit = TIP_CACHE.get(cache_key)
    if hit and now - hit["ts"] < TIP_CACHE_TTL:
        return JSONResponse({"tip": hit["tip"], "cached": True})
    try:
        tip = await asyncio.to_thread(ai_chat.generate_tip, image, lang=lang)
    except Exception as e:  # noqa: BLE001
        log("小贴士生成失败: %s" % e)
        return JSONResponse({"error": "生成失败: %s" % str(e)[:200]}, status_code=500)
    TIP_CACHE[cache_key] = {"tip": tip, "ts": now}
    if len(TIP_CACHE) > TIP_CACHE_MAX:
        for key in [k for k, v in TIP_CACHE.items() if now - v["ts"] > TIP_CACHE_TTL]:
            TIP_CACHE.pop(key, None)
    return JSONResponse({"tip": tip})


@app.post("/api/translate")
async def translate(request: Request):
    """把食物名称翻译成目标语言（带缓存），供前端展示记录时使用。"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体不是 JSON"}, status_code=400)
    texts = body.get("texts") if isinstance(body, dict) else None
    lang = body.get("lang") if isinstance(body, dict) else None
    if not isinstance(texts, list) or not texts:
        return JSONResponse({"error": "缺少 texts"}, status_code=400)
    texts = [str(t)[:500] for t in texts[:80]]
    try:
        result = translate_names(texts, lang)
    except Exception as e:  # noqa: BLE001
        log("翻译失败: %s" % e)
        return JSONResponse({"error": "翻译失败: %s" % e}, status_code=500)
    return JSONResponse({"translations": result, "lang": lang})


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    return await recognize(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("FOOD_AI_PORT", "5003")))
