#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把《中国食物成分表标准版(第6版)》JSON 源数据整理为服务用的统一营养库。

输入: nutrition/source_cfct_v3/merged_*.json
输出: nutrition/china_food_db.json

每条记录统一为:
{
  "code": "012001x",
  "name": "稻米（代表值）",
  "category": "谷类及其制品-稻米",
  "aliases": ["稻米", "大米"],
  "per100g": {"kcal":346, "protein":7.9, "fat":0.9, "carbs":77.2,
              "fiber":0.6, "sugar":0.1, "sodium":1.8, "water":13.3,
              "cholesterol":0, "ca":8, "fe":1.1}
}
其中 sugar 为按品类规则由 CHO-膳食纤维 折算的估计值（成分表无糖字段）。
"""
import glob
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "nutrition", "source_cfct_v3")
OUT = os.path.join(BASE, "nutrition", "china_food_db.json")

SUGAR_FACTOR = {
    "水果": 0.85,
    "乳类": 0.95,
    "谷类": 0.05,
    "薯类": 0.05,
    "淀粉": 0.05,
    "干豆": 0.30,
    "蔬菜": 0.35,
    "菌藻": 0.20,
    "坚果": 0.15,
    "种子": 0.15,
    "畜肉": 0.05,
    "禽肉": 0.05,
    "蛋类": 0.05,
    "鱼虾": 0.05,
    "油脂": 0.0,
    "其他": 0.20,
}


def num(v, default=0.0):
    if v is None:
        return default
    s = str(v).strip()
    if s in ("", "—", "-", "Tr", "tr", "TR"):
        return 0.0
    s = s.replace("(  )", "").replace("()", "")
    m = re.match(r"[-+]?\d*\.?\d+", s)
    if m:
        try:
            return float(m.group(0))
        except ValueError:
            return default
    return default


def clean_name(name):
    s = str(name).strip()
    s = s.replace("［", "[").replace("］", "]")
    return s


def aliases_for(name, category):
    """生成检索别名: 去掉括号/方括号限定词后的名字，以及常见俗称。"""
    out = set()
    base = re.sub(r"[（(［\[].*?[）)］\]]", "", name).strip()
    if base and base != name:
        out.add(base)
    base2 = re.sub(r"[（(［\[].*?[）)］\]]", "", name).strip()
    base2 = re.sub(r"(代表值|市售|熟|生|鲜|干)$", "", base2).strip()
    if base2 and base2 != name:
        out.add(base2)
    # 仅当主名与已知条目完全一致时才补充俗称，避免“五花肉”被标成“瘦肉”
    alias_map = {
        "稻米": ["大米", "白米"],
        "粳米": ["大米"],
        "籼米": ["大米"],
        "玉米": ["玉米", "甜玉米"],
        "马铃薯": ["土豆", "洋芋"],
        "甘薯": ["红薯", "地瓜"],
        "番茄": ["西红柿"],
        "花生仁": ["花生"],
        "鸡蛋": ["鸡蛋", "蛋"],
        "鸡胸脯肉": ["鸡胸肉"],
        "鸡腿": ["鸡腿肉"],
        "牛乳": ["牛奶"],
    }
    for k, vs in alias_map.items():
        if base == k:
            out.update(vs)
    return sorted(a for a in out if a and a != name)


def main():
    files = sorted(glob.glob(os.path.join(SRC, "merged_*.json")))
    if not files:
        print("源数据不存在:", SRC)
        sys.exit(1)
    records = []
    seen = set()
    for f in files:
        category = os.path.basename(f)[len("merged_"):-len(".json")]
        cat_key = category.split("-")[0]
        factor = SUGAR_FACTOR.get(cat_key, 0.2)
        for r in json.load(open(f, encoding="utf-8")):
            name = clean_name(r.get("foodName", ""))
            code = str(r.get("foodCode", "")).strip()
            if not name or code in seen:
                continue
            seen.add(code)
            cho = num(r.get("CHO"))
            fiber = num(r.get("dietaryFiber"))
            sugar = max(0.0, cho - fiber) * factor
            records.append({
                "code": code,
                "name": name,
                "category": category,
                "aliases": aliases_for(name, category),
                "per100g": {
                    "kcal": num(r.get("energyKCal")),
                    "protein": num(r.get("protein")),
                    "fat": num(r.get("fat")),
                    "carbs": cho,
                    "fiber": fiber,
                    "sugar": round(sugar, 1),
                    "sodium": num(r.get("Na")),
                    "water": num(r.get("water")),
                    "cholesterol": num(r.get("cholesterol")),
                    "ca": num(r.get("Ca")),
                    "fe": num(r.get("Fe")),
                },
            })
    records.sort(key=lambda x: (x["category"], x["code"]))
    with open(OUT, "w", encoding="utf-8") as fp:
        json.dump(records, fp, ensure_ascii=False, indent=1)
    print("已生成", OUT, len(records), "条")


if __name__ == "__main__":
    main()
