# 拾光 Android 套壳工程（store.picktime.app）

安卓用户的沉浸式 App：WebView 外壳 + 本地静态资源包 + 线上后端接口。

## 整体架构

```
安卓浏览器访问 https://picktime.store
        │  nginx 按 UA 判断（Android 且非 App）
        ▼
  /android/index.html  安卓专属下载页（强制下载，无跳过入口）
        │  点击下载
        ▼
  /download/PickTime.apk  签名安装包（约 7 MB）
        │  安装打开
        ▼
  WebView 壳（UA 含 PickTimeApp/版本号）
        ├─ 页面 HTML：线上拉取（前端改动即时生效）
        ├─ 静态资源：本地 assets/www 拦截返回（图片/字体/脚本秒开）
        ├─ /api/*、/auth/*：走线上后端（5002 / 5003 / 5001）
        └─ 离线时：自动回退到本地 HTML（?local=1）

iPhone / 桌面浏览器 → 维持原有 PWA 逻辑，完全不受影响
```

## 目录结构

```
picktime-android/
├── build.sh                 # 一键打包并发布 APK
├── settings.gradle
├── build.gradle
├── keystore/
│   ├── picktime-release.jks     # 签名证书（务必异地备份！）
│   └── keystore.properties      # 签名密码（chmod 600）
├── tools/make_icons.py      # 由 apple-touch-icon 生成各密度图标
└── app/src/main/
    ├── AndroidManifest.xml
    ├── java/store/picktime/app/MainActivity.java
    ├── assets/www/          # build.sh 自动从 /home/ubuntu/Picktime 同步
    └── res/                 # 图标 / 启动图 / 主题
```

## 打包新版本

```bash
cd /home/ubuntu/picktime-android
./build.sh 2 1.0.1        # 参数：versionCode versionName
```

脚本会：
1. 从 `/home/ubuntu/Picktime` 同步网页资源到 `assets/www`（排除 android/、download/、sw.js）
2. 构建签名 release APK
3. 校验签名
4. 发布到 `/home/ubuntu/Picktime/download/`：
   - `PickTime.apk`（下载页固定地址）
   - `PickTime-<版本>.apk`（带版本号留档）
   - `version.json`（App 启动时检查更新用）

> App 启动会请求 `/download/version.json`，发现 versionCode 更大时弹窗提示更新。

## 版本更新策略（重要）

### 情况一：只改前端页面 / 图片 / 字体（不发新 APK）

直接改 `/home/ubuntu/Picktime/` 里的文件即可，**用户无需更新 APK**：

| 改动类型 | 生效方式 |
|---|---|
| `index.html`（绝大多数改动） | App 每次启动都从线上拉 HTML，**重启 App 即最新** |
| 新增图片/字体等新文件 | 本地包没有 → 自动走网络加载，即时生效 |
| 修改同名旧图片/字体 | App 启动时比对 `version.json` 的 `webVersion`，与本地包不一致时**自动全部走线上**，不会看到旧图 |

> 最佳实践：修改已有图片/字体时，在 `index.html` 里把引用改成 `xxx.webp?v=2`
> （现有代码已是这种写法，如 `guide-2.jpg?v=2`），可绕过浏览器 7 天图片缓存。

### 情况二：改了 App 壳功能（原生代码 / 权限 / 图标等）

需要发新 APK：

```bash
cd /home/ubuntu/picktime-android
./build.sh 2 1.0.1        # 第二个参数 versionCode 必须比上一版大
```

发版后用户侧：

1. 打开 App → 启动时请求 `version.json`，发现 versionCode 更大 → 弹窗「发现新版本」
2. 点击「立即更新」→ 系统浏览器下载新 APK
3. 覆盖安装即可（签名相同，数据不丢失；无需卸载）

> 想强制更新（不更新不能用）：后续可在 `version.json` 增加 `minVersionCode` 字段，
> 并在 `MainActivity` 里把低于该版本的 App 弹窗改为不可取消。

### 情况三：同时改前端和壳

按情况二执行 `./build.sh` 即可，脚本会重新打包最新网页资源并更新 `webVersion`，
新装用户拿到最新本地包，老用户走线上（并在下次更新 APK 后恢复本地加速）。

### 版本戳原理

`build.sh` 会计算 `/home/ubuntu/Picktime` 全部网页文件的 md5（`webVersion`），同时写入：

- APK 内 `BuildConfig.WEB_VERSION`（编译进包）
- `/download/version.json` 的 `webVersion`

App 启动时比对两者：一致 → 静态资源走本地包（秒开）；不一致 → 静态资源走线上（保证最新）。

## Google 登录（重要）

Google 禁止在 WebView 内登录，因此：

1. App 内点击 Google 登录 → 拦截 `/auth/google`，改用系统浏览器打开 `?app=1`
2. 后端（picktime-sms/server.js）登录成功后重定向到 `picktime://google-auth?token=...`
3. App 通过 deep link 收到 token → 回到 WebView 加载 `/?google=1&token=...` 完成登录

服务端改动在 `picktime-sms/server.js` 的 `/auth/google` 与 `/auth/google/callback`：
只有带 `app=1` 时才走深链回跳，PWA 流程不变。

## 服务端（nginx）分流规则

`/etc/nginx/conf.d/picktime.store.conf`：

```nginx
map $http_user_agent $pt_is_android { default 0; "~*Android" 1; }
map $http_user_agent $pt_is_app     { default 0; "~*PickTimeApp" 1; }
map "$pt_is_android:$pt_is_app" $pt_gate_android { default 0; "1:0" 1; }
```

- `location = /`、`location = /index.html`：命中 `$pt_gate_android` → 重写到 `/android/index.html`
- `/android/`：下载页（自身不受跳转影响）
- `/download/`：APK 与 version.json（`.apk` 的 MIME 为 `application/vnd.android.package-archive`）
- `privacy.html` / `terms.html` 不拦截，安卓浏览器也能查看

## 测试清单（真机）

- [ ] 安卓手机浏览器打开 https://picktime.store → 出现下载页
- [ ] 点击"下载安卓安装包" → 下载 APK（约 7 MB）
- [ ] 安装时允许"未知来源" → 桌面出现「拾光」图标
- [ ] 打开 App → 启动图为奶油色 logo → 进入引导页 → 开始拾光
- [ ] 拍照识别（相机会申请权限）、相册上传、记录、统计、登录注册
- [ ] 手机号/邮箱登录可用；Google 登录会跳系统浏览器并自动回到 App
- [ ] 返回键：先回退页面，连续两次退出
- [ ] 断网重开 App → 仍能显示本地页面（接口不可用属正常）
- [ ] iPhone 打开 https://picktime.store → 仍是"添加到桌面"提示页

## 签名证书（务必备份）

```
keystore/picktime-release.jks
keystore/keystore.properties
```

证书 SHA-256：`FF:78:BF:4A:EC:E3:46:03:0F:A6:20:30:2B:C4:A2:DB:58:29:1D:D2:8C:E3:B7:95:FE:BF:30:5D:CB:21:48:DA`

丢失 keystore 将无法覆盖安装升级，只能卸载重装。建议复制到 U 盘/云盘/密码管理器。
