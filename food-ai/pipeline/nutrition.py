# -*- coding: utf-8 -*-
"""营养库：官方《中国食物成分表》+ 人工补充表 + 菜品配方分解。

核心思想：热量不直接采信大模型，而是
  菜品 -> 配方原料(%) -> 官方成分表每100g值 -> 加权得到该菜品每100g值 -> × 重量
未知菜品才回退到大模型的每100g估计，并降低置信度。
"""
import difflib
import json
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUT_DIR = os.path.join(BASE, "nutrition")

_PUNCT = re.compile(r"[\s（）()\[\]［］【】,，、;；:：·\-—_]+")
COOK_METHODS = ("炖", "烧", "炒", "煮", "蒸", "煎", "炸", "焖", "烩", "拌", "煲", "卤", "烤", "溜", "爆")


def normalize(s):
    s = str(s or "").strip().lower()
    s = _PUNCT.sub("", s)
    return s


def strip_qualifier(s):
    """去掉括号限定词: 猪肉（瘦）-> 猪肉; 纯牛奶（代表值，全脂）-> 纯牛奶"""
    s = re.sub(r"[（(［\[【].*?[）)］\]】]", "", str(s or ""))
    return s.strip()


class NutritionDB:
    def __init__(self):
        self.records = []
        self.by_key = {}
        self.recipes = {}
        self.knowledge = {}
        self.synonyms = {}
        self._load()

    def _load(self):
        with open(os.path.join(NUT_DIR, "china_food_db.json"), encoding="utf-8") as f:
            official = json.load(f)
        with open(os.path.join(NUT_DIR, "supplements.json"), encoding="utf-8") as f:
            supplements = json.load(f)
        with open(os.path.join(NUT_DIR, "dish_recipes.json"), encoding="utf-8") as f:
            raw_recipes = json.load(f)
        with open(os.path.join(NUT_DIR, "food_knowledge.json"), encoding="utf-8") as f:
            self.knowledge = json.load(f)

        self.records = official + supplements
        for r in self.records:
            r["_norm"] = normalize(r["name"])
            r["_base"] = normalize(strip_qualifier(r["name"]))
            keys = {r["_norm"], r["_base"]}
            for a in r.get("aliases", []):
                keys.add(normalize(a))
            for k in keys:
                if not k:
                    continue
                # 代表值优先
                if k in self.by_key and "代表值" in self.by_key[k]["name"]:
                    continue
                self.by_key.setdefault(k, r)

        self.synonyms = {normalize(k): v for k, v in self.knowledge.get("ingredient_synonyms", {}).items()}
        self.recipes = {}
        for name, rec in raw_recipes.items():
            if name.startswith("_"):
                continue
            self.recipes[normalize(name)] = dict(rec, name=name)
        # 配方名也建索引（去掉“（猪肉馅）”等）
        for name, rec in list(self.recipes.items()):
            base = normalize(strip_qualifier(rec["name"]))
            if base:
                self.recipes.setdefault(base, rec)

    # ---------- 查询 ----------
    def match(self, name):
        """把名称匹配到一条食物记录，返回 (record, 置信度)。"""
        q = normalize(name)
        if not q:
            return None, 0.0
        if q in self.by_key:
            return self.by_key[q], 0.95
        if q in self.synonyms:
            s = normalize(self.synonyms[q])
            if s in self.by_key:
                return self.by_key[s], 0.9
        # 双向子串匹配（取最长）
        best = None
        best_len = 0
        for key, rec in self.by_key.items():
            if len(key) < 2:
                continue
            if key in q or (q in key and len(q) >= 2):
                if len(key) > best_len or (len(key) == best_len and "代表值" in rec["name"]):
                    best, best_len = rec, len(key)
        if best is not None and best_len >= 2:
            return best, 0.75 if best_len >= len(q) else 0.65
        # 模糊匹配
        cand = difflib.get_close_matches(q, list(self.by_key.keys()), n=1, cutoff=0.62)
        if cand:
            return self.by_key[cand[0]], 0.55
        return None, 0.0

    def match_recipe(self, name):
        """匹配菜品配方，返回 (recipe, 置信度)。"""
        q = normalize(name)
        if not q:
            return None, 0.0
        if q in self.recipes:
            return self.recipes[q], 0.95
        best = None
        best_len = 0
        for key, rec in self.recipes.items():
            if len(key) < 2:
                continue
            if key in q or (q in key and len(q) >= 2):
                if len(key) > best_len:
                    best, best_len = rec, len(key)
        if best is not None:
            return best, 0.8
        # 近似菜名（如 土豆鸡块 -> 土豆炖鸡块）
        cand = difflib.get_close_matches(q, list(self.recipes.keys()), n=1, cutoff=0.6)
        if cand:
            return self.recipes[cand[0]], 0.6
        return None, 0.0

    def category_default(self, name):
        """按关键词给出大类兜底每100g营养。"""
        s = str(name)
        groups = [
            ("饮料", ["可乐", "雪碧", "汽水", "咖啡", "奶茶", "果汁", "啤酒", "红酒", "白酒", "茶", "矿泉水", "豆浆", "饮料", "奶昔"]),
            ("汤羹", ["汤", "羹", "粥", "糊"]),
            ("甜点", ["蛋糕", "面包", "饼干", "曲奇", "月饼", "蛋挞", "甜甜圈", "泡芙", "冰淇淋", "雪糕", "巧克力", "甜品", "派", "布丁"]),
            ("油炸", ["炸", "薯条", "薯片", "油条", "春卷", "天妇罗"]),
            ("水果", ["苹果", "香蕉", "橙", "橘", "西瓜", "葡萄", "草莓", "蓝莓", "芒果", "桃", "梨", "樱桃", "火龙果", "哈密瓜", "菠萝", "柚", "柠檬", "牛油果", "榴莲", "猕猴桃", "水果"]),
            ("坚果", ["花生", "核桃", "瓜子", "杏仁", "腰果", "开心果", "松子", "榛子", "坚果"]),
            ("乳制品", ["牛奶", "酸奶", "奶酪", "芝士", "奶油", "炼乳", "奶"]),
            ("蛋类", ["蛋"]),
            ("水产", ["鱼", "虾", "蟹", "贝", "鱿", "章鱼", "海参", "生蚝", "蚝"]),
            ("豆制品", ["豆腐", "豆干", "腐竹", "豆皮", "素鸡"]),
            ("肉类", ["肉", "鸡", "鸭", "牛", "羊", "猪", "排骨", "培根", "火腿", "香肠", "腊", "狮子头", "里脊"]),
            ("蔬菜", ["菜", "瓜", "茄", "椒", "菇", "菌", "笋", "豆角", "萝卜", "土豆", "山药", "藕", "番茄", "洋葱", "西兰花"]),
            ("主食", ["饭", "面", "粉", "馒头", "包子", "饺子", "馄饨", "饼", "粽", "年糕", "汤圆", "粥", "米线", "河粉", "意面", "披萨", "汉堡", "三明治", "麦片", "燕麦"]),
        ]
        for group, kws in groups:
            for kw in kws:
                if kw in s:
                    return dict(self.knowledge["category_defaults"][group]), group
        return dict(self.knowledge["category_defaults"]["default"]), "default"

    def recipe_per100g(self, recipe):
        """把配方按原料加权成每100g营养。返回 (per100g, 命中率)。"""
        acc = {"kcal": 0.0, "protein": 0.0, "fat": 0.0, "carbs": 0.0,
               "fiber": 0.0, "sugar": 0.0, "sodium": 0.0}
        total_pct = 0.0
        hit_pct = 0.0
        for item in recipe.get("ingredients", []):
            ing, pct = item[0], float(item[1])
            total_pct += pct
            rec, conf = self.match(ing)
            if rec:
                p = rec["per100g"]
                hit_pct += pct
            else:
                p, _ = self.category_default(ing)
            for k in acc:
                acc[k] += p.get(k, 0.0) * pct
        if total_pct <= 0:
            return None, 0.0
        for k in acc:
            acc[k] = round(acc[k] / total_pct, 1)
        return acc, hit_pct / total_pct

    def per100g_for(self, name, qwen_item=None):
        """得到某食物的每100g营养与来源说明。

        返回 (per100g, source, confidence)
        """
        recipe, rconf = self.match_recipe(name)
        if recipe:
            p, hit = self.recipe_per100g(recipe)
            if p:
                src = "recipe" if hit >= 0.75 else "recipe_partial"
                return p, src, rconf * (0.6 + 0.4 * hit)
        rec, conf = self.match(name)
        # 含烹饪方式的菜品名（如“土豆炖鸡块”）不应低置信度地匹配到单一食材记录
        if rec and not (conf < 0.7 and any(m in str(name) for m in COOK_METHODS)):
            return dict(rec["per100g"]), "cfct:" + rec["name"], conf
        if qwen_item:
            keys = [("kcal", "kcalPer100g"), ("protein", "proteinPer100g"), ("fat", "fatPer100g"),
                    ("carbs", "carbsPer100g"), ("sugar", "sugarPer100g"), ("fiber", "fiberPer100g"),
                    ("sodium", "sodiumPer100g")]
            defaults, _ = self.category_default(name)
            p = {}
            got = False
            for k, qk in keys:
                v = qwen_item.get(qk)
                val = None
                if v is not None:
                    try:
                        val = float(v)
                        got = True
                    except (TypeError, ValueError):
                        val = None
                p[k] = val if val is not None else defaults.get(k, 0.0)
            if got and p.get("kcal", 0) > 0:
                return p, "qwen", 0.4
        p, group = self.category_default(name)
        return p, "category_default:" + group, 0.25
