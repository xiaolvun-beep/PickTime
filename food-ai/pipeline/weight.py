# -*- coding: utf-8 -*-
"""重量估算引擎。

核心公式（流程树中的“面积 × 深度 × 尺度 × 密度 + 常见份量修正”）：

  面积 A(cm²) = 掩码像素数 × (cm/px)²
  厚度 T(cm)   = 深度测量值 与 品类先验 融合（无深度时用先验）
  体积 V(cm³)  = A × T × 填充系数(0.85)
  几何重量     = V × 密度(g/cm³)
  最终重量     = 几何重量、单位件重(count×常见单重)、模型粗估 三者按尺度置信度加权
  并夹在 [0.3×模型粗估, 2.5×模型粗估] 内做常识约束

尺度(cm/px)优先用图中餐具等参照物标定；无参照物时退回品类典型直径。
"""
import numpy as np

DRINK_KEYWORDS = ["可乐", "雪碧", "汽水", "咖啡", "奶茶", "果汁", "啤酒", "红酒",
                  "白酒", "茶", "矿泉水", "水", "豆浆", "饮料", "奶昔", "牛奶", "酸奶"]


def keyword_value(table, name, default_key="default"):
    """在名称中找命中的最长关键词，返回对应值。"""
    name = str(name or "")
    best = None
    best_len = 0
    for k, v in table.items():
        if k.startswith("_") or k == "default":
            continue
        if k in name and len(k) > best_len:
            best, best_len = v, len(k)
    if best is None:
        return table.get(default_key)
    return best


def box_size_cm(box, measure):
    x1, y1, x2, y2 = box
    w = max(1.0, x2 - x1)
    h = max(1.0, y2 - y1)
    if measure == "length":
        return float(np.hypot(w, h))
    return max(w, h)


def center(box):
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def estimate_scale(food_box, food_name, qwen_refs, yolo_refs, knowledge, image_diag):
    """返回 (cm_per_px, confidence, ref_desc)。"""
    fcx, fcy = center(food_box)
    cands = []
    for r in qwen_refs or []:
        box = r.get("box")
        size = r.get("size_cm")
        measure = r.get("measure", "diameter")
        if not box or not size:
            continue
        px = box_size_cm(box, measure)
        if px <= 5:
            continue
        cm_per_px = float(size) / px
        cx, cy = center(box)
        dist = float(np.hypot(cx - fcx, cy - fcy)) / max(1.0, image_diag)
        cands.append((dist, float(r.get("conf", 0.78)), cm_per_px,
                      "参照物:%s(%.0fcm)" % (r.get("name", "?"), float(size))))
    for r in yolo_refs or []:
        box = r.get("box")
        size = r.get("size_cm")
        if not box or not size:
            continue
        px = box_size_cm(box, r.get("measure", "diameter"))
        if px <= 5:
            continue
        cm_per_px = float(size) / px
        cx, cy = center(box)
        dist = float(np.hypot(cx - fcx, cy - fcy)) / max(1.0, image_diag)
        cands.append((dist, 0.82, cm_per_px, "YOLO参照物:%s(%.0fcm)" % (r.get("name", "?"), float(size))))
    if cands:
        cands.sort(key=lambda c: c[0])
        _, conf, cm_per_px, desc = cands[0]
        # 距离相近的参照物视为同一目标的多来源估计，取中位数增强稳健性
        near = [c for c in cands if c[0] <= max(cands[0][0] * 1.6, cands[0][0] + 0.05)]
        vals = sorted(c[2] for c in near)
        med = vals[len(vals) // 2]
        if len(near) >= 2 and med > 0 and (cm_per_px / med > 1.35 or cm_per_px / med < 0.74):
            cm_per_px = med
            desc += "(多参照物中位)"
        if len(vals) > 1 and vals[-1] / max(1e-6, vals[0]) > 2.0:
            conf *= 0.7
        return cm_per_px, conf, desc

    # 退回品类典型直径
    typical = knowledge["typical_diameter_cm"]
    dia = keyword_value(typical, food_name, default_key="default")
    x1, y1, x2, y2 = food_box
    px = max(1.0, max(x2 - x1, y2 - y1))
    cm_per_px = float(dia) / px
    conf = 0.35 if str(dia) != str(typical.get("default")) else 0.25
    return cm_per_px, conf, "品类先验直径:%.0fcm" % float(dia)


def estimate_thickness(depth_map, mask, food_box, ref_box, cm_per_px, food_name, knowledge):
    """返回 (thickness_cm, measured: bool, note)。"""
    prior = float(keyword_value(knowledge["thickness_cm"], food_name, default_key="default"))
    if depth_map is None or mask is None or mask.sum() < 50:
        return prior, False, "先验厚度"
    h, w = depth_map.shape[:2]
    m = mask.astype(bool)
    if m.shape != depth_map.shape:
        m = m[:h, :w]

    food_vals = depth_map[m]
    if food_vals.size < 50:
        return prior, False, "先验厚度"
    food_top = float(np.percentile(food_vals, 90))

    # 食物周边环带（盘子/桌面）作为基准面
    x1, y1, x2, y2 = [int(v) for v in food_box]
    pad_x = max(5, int((x2 - x1) * 0.25))
    pad_y = max(5, int((y2 - y1) * 0.25))
    rx1, ry1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    rx2, ry2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
    ring = np.zeros_like(m)
    ring[ry1:ry2, rx1:rx2] = True
    ring &= ~m
    if ring.sum() < 30:
        return prior, False, "先验厚度"
    # 基准面取环带的较近四分位（食物底部的盘面），避免远处桌面把基准拉低
    bg = float(np.percentile(depth_map[ring], 75))
    height_rel = food_top - bg
    if height_rel <= 0:
        return prior * 0.8, False, "深度无高度信息"

    # 深度单位 -> 厘米：用参照物的深度跨度标定；无参照物时用画面整体动态范围近似
    if ref_box is not None:
        bx1, by1, bx2, by2 = [int(v) for v in ref_box]
        ref_region = depth_map[max(0, by1):by2, max(0, bx1):bx2]
        if ref_region.size > 50:
            span = float(np.percentile(ref_region, 95) - np.percentile(ref_region, 5))
            ref_size = box_size_cm(ref_box, "diameter")
            if span > 1e-4:
                cm_per_depth = ref_size / span
            else:
                cm_per_depth = None
        else:
            cm_per_depth = None
    else:
        cm_per_depth = None

    if cm_per_depth is None:
        # 用食物自身水平尺寸与深度跨度估计景深比例（保守）
        span = float(np.percentile(depth_map, 95) - np.percentile(depth_map, 5))
        if span <= 1e-4:
            return prior, False, "先验厚度"
        width_cm = max(1.0, (food_box[2] - food_box[0]) * cm_per_px)
        cm_per_depth = width_cm / span * 0.5

    # 单目深度只有相对意义，测厚保守：限制在品类先验的 0.5~1.3 倍并只占 30% 权重
    measured = height_rel * cm_per_depth
    measured = min(max(measured, 0.5 * prior), 1.3 * prior)
    thickness = 0.3 * measured + 0.7 * prior
    return float(thickness), True, "深度测量(%.1fcm)" % thickness


def estimate_mass(food, mask, depth_map, knowledge, scale_info, thickness_info, unit_weight,
                  area_cap_cm2=None):
    """计算单个食物总重量（count 份合计），返回 (grams, detail dict)。"""
    name = food.get("name", "")
    count = max(1, int(food.get("count") or 1))
    cm_per_px, scale_conf, scale_desc = scale_info
    thickness, measured, thick_note = thickness_info
    llm = food.get("portionGrams")
    if not llm and isinstance(food.get("qwen"), dict):
        llm = food["qwen"].get("portionGrams")
    try:
        llm = float(llm) if llm else None
    except (TypeError, ValueError):
        llm = None

    is_drink = any(k in name for k in DRINK_KEYWORDS)
    mass_geo = None
    area_cm2 = None
    if mask is not None and mask.sum() > 50 and not is_drink:
        area_cm2 = float(mask.sum()) * cm_per_px * cm_per_px
        if area_cap_cm2 and area_cap_cm2 > 0:
            area_cm2 = min(area_cm2, float(area_cap_cm2))
        density = float(keyword_value(knowledge["density"], name, default_key="default"))
        fill = float(keyword_value(knowledge.get("fill_factor", {}), name, default_key="default"))
        mass_geo = area_cm2 * thickness * fill * density

    mass_unit = None
    if unit_weight and count:
        mass_unit = float(unit_weight) * count

    # 组合权重：几何估算为主，单位件重次之，大模型粗估只作校正（其份量估计整体偏高）
    if is_drink:
        parts = [(mass_unit, 0.6), (llm, 0.4)]
    elif scale_conf >= 0.6:
        parts = [(mass_geo, 0.50), (mass_unit, 0.30), (llm, 0.20)]
    else:
        parts = [(mass_geo, 0.35), (mass_unit, 0.35), (llm, 0.30)]
    wsum = sum(w for v, w in parts if v is not None and v > 0)
    if wsum <= 0:
        grams = llm or 100.0
    else:
        grams = sum(v * w for v, w in parts if v is not None and v > 0) / wsum

    # 常识约束：收紧上界，避免份量系统性偏高
    if llm and llm > 0:
        grams = min(max(grams, 0.35 * llm), 1.8 * llm)
    grams = float(min(max(grams, 5.0), 6000.0))

    detail = {
        "scale": scale_desc, "scaleConf": round(scale_conf, 2),
        "thicknessCm": round(thickness, 1), "thicknessNote": thick_note,
        "areaCm2": round(area_cm2, 1) if area_cm2 else None,
        "massGeo": round(mass_geo, 1) if mass_geo else None,
        "massUnit": round(mass_unit, 1) if mass_unit else None,
        "massLLM": llm, "grams": round(grams, 1), "drink": is_drink,
    }
    return grams, detail
