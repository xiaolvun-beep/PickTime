# -*- coding: utf-8 -*-
"""第二~四步：YOLO26「在哪里」、SAM2「哪些像素」、Depth-Anything-V2「多厚」。

所有模型在统一降采样图（最长边 1024）上推理，像素面积最后按比例还原。
模型常驻内存，SAM2 图像编码每张图只做一次。
"""
import os
import sys
import threading
import time

import cv2
import numpy as np
import torch

torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAM2_DIR = os.environ.get("SAM2_DIR", "/home/ubuntu/sam2")
DA2_DIR = os.environ.get("DA2_DIR", "/home/ubuntu/Depth-Anything-V2")
YOLO_WEIGHTS = os.environ.get("YOLO_WEIGHTS", "/home/ubuntu/yolo26n.pt")
# SAM2 编码分辨率与深度输入分辨率：默认降低以减少 CPU 推理耗时（1024→768、518→384）
SAM2_IMAGE_SIZE = int(os.environ.get("SAM2_IMAGE_SIZE", "768"))
DEPTH_INPUT_SIZE = int(os.environ.get("DEPTH_INPUT_SIZE", "384"))

FOOD_CLASSES = {
    "banana": "香蕉", "apple": "苹果", "sandwich": "三明治", "orange": "橙子",
    "broccoli": "西兰花", "carrot": "胡萝卜", "hot dog": "热狗", "pizza": "披萨",
    "donut": "甜甜圈", "cake": "蛋糕",
}
REFERENCE_CLASSES = {
    "bowl": ("碗", 14.0, "diameter"),
    "cup": ("杯子", 8.0, "diameter"),
    "fork": ("叉子", 19.0, "length"),
    "knife": ("刀", 20.0, "length"),
    "spoon": ("勺子", 18.0, "length"),
    "bottle": ("瓶子", 6.5, "diameter"),
    "wine glass": ("酒杯", 8.0, "diameter"),
}


class VisionModels:
    def __init__(self, log=print):
        self.log = log
        self._lock = threading.Lock()
        self._yolo = None
        self._sam2 = None
        self._sam2_predictor = None
        self._depth = None
        self._loaded = False
        self._depth_cache = {}

    # ---------- 加载 ----------
    def load(self):
        if self._loaded:
            return
        t0 = time.time()
        from ultralytics import YOLO
        self._yolo = YOLO(YOLO_WEIGHTS)
        self.log("[vision] YOLO26 加载完成 %.1fs" % (time.time() - t0))

        t0 = time.time()
        sys.path.insert(0, SAM2_DIR)
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        ckpt = os.path.join(SAM2_DIR, "checkpoints", "sam2.1_hiera_tiny.pt")
        self._sam2 = build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", ckpt, device="cpu",
                                hydra_overrides_extra=["++model.image_size=%d" % SAM2_IMAGE_SIZE])
        self._sam2_predictor = SAM2ImagePredictor(self._sam2)
        if SAM2_IMAGE_SIZE != 1024:
            feat = SAM2_IMAGE_SIZE // 4
            self._sam2_predictor._bb_feat_sizes = [
                (feat, feat), (feat // 2, feat // 2), (feat // 4, feat // 4)]
        self.log("[vision] SAM2.1-tiny 加载完成 %.1fs (%dpx)" % (time.time() - t0, SAM2_IMAGE_SIZE))

        t0 = time.time()
        sys.path.insert(0, DA2_DIR)
        from depth_anything_v2.dpt import DepthAnythingV2
        cfg = {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]}
        self._depth = DepthAnythingV2(**cfg)
        ckpt = os.path.join(DA2_DIR, "checkpoints", "depth_anything_v2_vits.pth")
        self._depth.load_state_dict(torch.load(ckpt, map_location="cpu"))
        self._depth.eval()
        self.log("[vision] Depth-Anything-V2 加载完成 %.1fs" % (time.time() - t0))
        self._loaded = True

    # ---------- YOLO ----------
    @torch.inference_mode()
    def yolo(self, image_bgr, conf=0.25):
        res = self._yolo.predict(image_bgr, imgsz=640, conf=conf, verbose=False, device="cpu")[0]
        out = []
        names = res.names
        for b in res.boxes:
            cls_name = names[int(b.cls)]
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
            item = {"en": cls_name, "conf": float(b.conf), "box": [x1, y1, x2, y2]}
            if cls_name in FOOD_CLASSES:
                item.update(kind="food", name=FOOD_CLASSES[cls_name])
            elif cls_name in REFERENCE_CLASSES:
                cn, size, measure = REFERENCE_CLASSES[cls_name]
                item.update(kind="reference", name=cn, size_cm=size, measure=measure)
            else:
                continue
            out.append(item)
        return out

    # ---------- SAM2 ----------
    @torch.inference_mode()
    def sam2_set_image(self, image_rgb):
        self._sam2_predictor.set_image(image_rgb)

    @torch.inference_mode()
    def sam2_mask(self, box):
        """返回 (bool掩码, 分数, 软alpha[0-255])。

        软 alpha 来自未二值化的 logits（sigmoid 概率），供抠图补漏使用；
        bool 掩码用于面积/重量计算。
        """
        masks, scores, logits = self._sam2_predictor.predict(
            box=np.asarray(box, dtype=np.float32)[None, :], multimask_output=False,
            return_logits=True)
        logit = logits[0]
        prob = 1.0 / (1.0 + np.exp(-np.clip(logit, -20.0, 20.0)))
        alpha = np.clip(prob * 255.0, 0, 255).astype(np.uint8)
        # return_logits=True 时 masks 是未阈值化的 logits，必须按 0 阈值二值化
        return masks[0] > 0, float(scores[0]), alpha

    # ---------- Depth ----------
    @torch.inference_mode()
    def depth(self, image_bgr):
        d = self._depth.infer_image(image_bgr, input_size=DEPTH_INPUT_SIZE)
        return np.asarray(d, dtype=np.float32)


def resize_for_models(image_bgr, max_side=1024):
    h, w = image_bgr.shape[:2]
    scale = min(1.0, max_side / float(max(h, w)))
    if scale >= 1.0:
        return image_bgr, 1.0
    out = cv2.resize(image_bgr, (int(round(w * scale)), int(round(h * scale))),
                     interpolation=cv2.INTER_AREA)
    return out, scale
