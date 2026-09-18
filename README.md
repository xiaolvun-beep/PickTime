# 拾光 PickTime

拍照记录饮食：智能抠图 + AI 食物识别（名称 / 热量 / 蛋白 / 脂肪 / 碳水 / 糖 / 纤维 / 钠），支持时间线、月历热力图、热量趋势与体脂率参考。

> PickTime — snap a photo, get the food name, calories and six nutrients, and keep a warm timeline of every meal.

## 功能

- 拍照或相册选图，自动抠图（美图 AI / 本机 U2NET 兜底）
- YOLO26 + SAM2 + Depth-Anything-V2 食物分割与重量估算，营养库匹配热量
- 添加详情页「询问 AI」（Doubao Seed 2.1 Pro）：
  - 发食物图片重新识别，确认后回填名称、热量与六项营养
  - 按「吃了多少克」估算，或上传包装营养成分表换算
  - 营养成分表缺少糖 / 纤维等项目时说明并给出估算值
- 首页时间线、统计页月历 / 热力图 / 近 7 天热量趋势
- 账号系统：手机号、QQ 邮箱、Google 登录，记录云端同步
- 多语言：简体中文 / English / 日本語 / 한국어
- PWA 与安卓 App（WebView 套壳 + 本地资源包）

## 架构与端口

```
浏览器 / 安卓 App
   │
 nginx（8050 静态站 + API 反代）
   ├── /api/recognize ─► 5002 账号服务 ─► 5003 识别服务（YOLO26/SAM2/DepthV2 + Qwen-VL + 营养库）
   ├── /api/ai-chat   ─► 5002 账号服务 ─► 5003 识别服务 ─► Doubao（火山方舟 Ark）
   ├── /api/cutout    ─► 5002 账号服务 ─► 美图 AI / 5001 本机 U2NET
   └── 其余 /api/*、/auth/* ─► 5002 账号服务（MySQL）
```

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| 网页静态站 | 8050 | nginx 直接托管 `Picktime/` |
| 账号服务 | 5002 | Node.js + MySQL（登录、记录、API 代理） |
| 识别服务 | 5003 | Python FastAPI（YOLO26 + SAM2 + DepthV2 + Qwen-VL） |
| 本机抠图 | 5001 | U2NET ONNX（美图不可用时的兜底） |

## 目录结构

```
├── Picktime/              # 网页前端（PWA，含安卓下载页）
├── picktime-sms/          # 账号服务（5002）
├── food-ai/               # 食物识别服务（5003）
├── picktime-android/      # 安卓套壳工程（WebView + 本地资源包）
├── deploy.sh              # 一键部署脚本
├── nginx-picktime-8050.conf   # 仅 8050 的 nginx 配置
├── nginx-picktime.store.conf  # 含域名 443 的 nginx 配置
├── picktime-db.sql        # 数据库表结构
└── 部署说明.txt
```

## 快速部署

目标机：Ubuntu 24.04（需要系统自带 python3.12）、MySQL、nginx。

```bash
# 1. 建库并导入表结构
mysql -uroot -p -e "CREATE DATABASE IF NOT EXISTS picktime DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -uroot -p picktime < picktime-db.sql

# 2. 配置密钥
cp picktime-sms/ecosystem.config.example.js picktime-sms/ecosystem.config.js
cp food-ai/ecosystem.config.example.js food-ai/ecosystem.config.js
#    编辑两个 ecosystem.config.js 填入数据库、短信、邮箱、Google、Qwen、Doubao 等密钥

# 3. 启动服务
bash deploy.sh
```

详细步骤见 [`部署说明.txt`](部署说明.txt)。仓库只含源码，模型权重（YOLO26 / SAM2 / DepthV2）与 Python 环境请参考 `food-ai/pipeline/vision.py` 中的路径自行下载放置。

## 主要配置项

| 变量 | 用途 |
| --- | --- |
| `DASHSCOPE_API_KEY` | 拍照识别 Qwen-VL（阿里云百炼） |
| `ARK_API_KEY` / `DOUBAO_CHAT_MODEL` | 添加页「询问 AI」Doubao（火山方舟） |
| `MEITU_OPEN_AK` / `MEITU_OPEN_SK` | 美图 AI 开放平台智能抠图 |
| `PICKTIME_DB_*` | MySQL 连接 |
| `SMS_*` / `EMAIL_*` / `GOOGLE_*` | 手机号 / 邮箱 / Google 登录 |

所有密钥都通过环境变量注入，请勿提交到仓库。

## 安卓 App

```bash
cd picktime-android
# 需要 JDK 17 与 Android SDK；签名配置见 keystore/keystore.properties
bash build.sh <versionCode> <versionName>
```

## 第三方

- [`Picktime/vendor/thinking-orbs-engine.es.js`](Picktime/vendor/) 基于 [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs)（MIT License, © 2026 Jakub Antalik），许可证见同目录 `thinking-orbs-LICENSE.txt`。
- 食物营养数据参考中国食物成分表整理。
