package store.picktime.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private static final String SITE_HOST = "picktime.store";
    private static final String SITE_HOST_WWW = "www.picktime.store";
    private static final String HOME_URL = "https://" + SITE_HOST + "/";
    private static final String VERSION_URL = "https://" + SITE_HOST + "/download/version.json";
    private static final String APK_URL = "https://" + SITE_HOST + "/download/PickTime.apk";
    // 与服务端 nginx 约定的 App 识别令牌（UA 被代理改写时的兜底）
    private static final String APP_TOKEN = "pt9f3a7c21b8e";
    private static final String APP_COOKIE = "picktime_app=1; path=/; max-age=31536000";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_PERM_CAMERA = 1002;
    private static final int REQ_PERM_LOCATION = 1003;
    private static final int REQ_INSTALL_PERMISSION = 1004;

    // true：页面 HTML 走线上（前端改动即时生效），静态资源用本地包；离线时自动回退到本地 HTML
    // false：HTML 与静态资源全部使用本地包（完全离线，但每次前端改动都需要重新发版）
    private static final boolean REMOTE_HTML = true;

    private WebView webView;
    private WebView popupWebView;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean localFallbackLoaded = false;
    // 本地资源包是否与线上一致（线上有新版本时自动全部走网络，保证内容最新）
    private volatile boolean useLocalAssets = true;
    private volatile boolean reloadedForWebVersion = false;
    private volatile boolean updateDownloadCancelled = false;
    private Dialog updateDialog;
    private File pendingInstallApk;
    private PermissionRequest pendingPermissionRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private long lastBackPressed = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.WHITE);
        setContentView(webView);

        configureWebView();

        if (!handleDeepLink(getIntent())) {
            boolean offline = REMOTE_HTML && !hasNetwork();
            webView.loadUrl(offline ? HOME_URL + "index.html?local=1&app=" + APP_TOKEN
                    : HOME_URL + "?app=" + APP_TOKEN);
        }
        checkForUpdates();
    }

    @SuppressWarnings("deprecation")
    private boolean hasNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network network = cm.getActiveNetwork();
                if (network == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            NetworkInfo info = cm.getActiveNetworkInfo();
            return info != null && info.isConnected();
        } catch (Exception e) {
            return true;
        }
    }

    private void configureWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            window.setNavigationBarColor(Color.WHITE);
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        String ua = WebSettings.getDefaultUserAgent(this);
        ua = ua.replace("; wv", "").replace(" wv", "");
        if (!ua.contains("PickTimeApp")) {
            ua = ua + " PickTimeApp/" + BuildConfig.VERSION_NAME;
        }
        settings.setUserAgentString(ua);

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setWebContentsDebuggingEnabled(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);
        // 写入 App 识别 Cookie，避免部分环境（模拟器/代理）改写 UA 导致被误判成浏览器
        cookieManager.setCookie("https://" + SITE_HOST, APP_COOKIE);
        cookieManager.flush();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return interceptLocalAsset(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (!REMOTE_HTML) return;
                if (request == null || !request.isForMainFrame()) return;
                if (localFallbackLoaded) return;
                localFallbackLoaded = true;
                view.loadUrl(HOME_URL + "index.html?local=1&app=" + APP_TOKEN);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String type = "*/*";
                String[] acceptTypes = params.getAcceptTypes();
                if (acceptTypes != null) {
                    StringBuilder sb = new StringBuilder();
                    for (String accept : acceptTypes) {
                        if (accept == null || accept.trim().isEmpty()) continue;
                        if (sb.length() > 0) sb.append(",");
                        sb.append(accept.trim());
                    }
                    if (sb.length() > 0) type = sb.toString();
                }
                intent.setType(type);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择图片"), REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean needCamera = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            needCamera = true;
                            break;
                        }
                    }
                    if (needCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        pendingPermissionRequest = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM_CAMERA);
                        return;
                    }
                    request.grant(request.getResources());
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoCallback = callback;
                    pendingGeoOrigin = origin;
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    }, REQ_PERM_LOCATION);
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                if (popupWebView != null) {
                    popupWebView.destroy();
                    popupWebView = null;
                }
                final WebView popup = new WebView(MainActivity.this);
                popupWebView = popup;
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        return handlePopupUrl(request.getUrl());
                    }

                    @Override
                    @SuppressWarnings("deprecation")
                    public boolean shouldOverrideUrlLoading(WebView v, String url) {
                        return handlePopupUrl(Uri.parse(url));
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                openExternal(Uri.parse(url)));
    }

    private boolean isSameSite(Uri uri) {
        if (uri == null) return false;
        String host = uri.getHost();
        return SITE_HOST.equalsIgnoreCase(host) || SITE_HOST_WWW.equalsIgnoreCase(host);
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;

        if (scheme.equals("http") || scheme.equals("https")) {
            if (isSameSite(uri)) {
                String path = uri.getPath() == null ? "" : uri.getPath();
                if (path.startsWith("/auth/google")) {
                    // Google 禁止在 WebView 内登录，改用系统浏览器 + picktime:// 深链回跳
                    openExternal(uri.buildUpon().appendQueryParameter("app", "1").build());
                    return true;
                }
                return false;
            }
            openExternal(uri);
            return true;
        }

        // mailto / tel / weixin / alipays / xhs 等外部协议
        openExternal(uri);
        return true;
    }

    private boolean handlePopupUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if (scheme == null) return true;
        if ((scheme.equals("http") || scheme.equals("https")) && isSameSite(uri)) {
            if (webView != null) webView.loadUrl(uri.toString());
        } else {
            openExternal(uri);
        }
        return true;
    }

    private WebResourceResponse interceptLocalAsset(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
        String host = uri.getHost();
        if (!SITE_HOST.equalsIgnoreCase(host) && !SITE_HOST_WWW.equalsIgnoreCase(host)) return null;

        String path = uri.getPath();
        if (path == null) return null;
        // 接口、登录、下载一律走网络
        if (path.startsWith("/api/") || path.startsWith("/auth/") || path.startsWith("/download/")) {
            return null;
        }
        // Service Worker 返回空实现，避免缓存旧版静态资源
        if (path.equals("/sw.js")) {
            String stub = "self.addEventListener('install',function(e){self.skipWaiting();});"
                    + "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});";
            return new WebResourceResponse("application/javascript", "utf-8",
                    new ByteArrayInputStream(stub.getBytes(StandardCharsets.UTF_8)));
        }
        // 页面 HTML：默认走线上以便前端即时更新，?local=1 时使用本地兜底
        boolean isHtmlPage = path.equals("/") || path.equals("/index.html");
        boolean forceLocal = "1".equals(uri.getQueryParameter("local"));
        if (!forceLocal) {
            if (REMOTE_HTML && isHtmlPage) return null;
            // 本地资源包已过期：静态资源也走线上，避免同名旧图/旧字体
            if (!useLocalAssets) return null;
        }

        String assetPath = path.equals("/") ? "index.html" : path.substring(1);
        if (assetPath.isEmpty() || assetPath.contains("..")) return null;

        try {
            String mime = mimeOf(assetPath);
            String encoding = isTextMime(mime) ? "utf-8" : null;
            InputStream stream = getAssets().open("www/" + assetPath);
            return new WebResourceResponse(mime, encoding, 200, "OK", null, stream);
        } catch (IOException e) {
            // 本地没有的资源（如用户上传内容）回退到线上
            return null;
        }
    }

    private boolean isTextMime(String mime) {
        return mime.startsWith("text/")
                || mime.contains("json")
                || mime.contains("javascript")
                || mime.contains("xml");
    }

    private String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".otf")) return "font/otf";
        if (p.endsWith(".mp4")) return "video/mp4";
        if (p.endsWith(".webm")) return "video/webm";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".txt")) return "text/plain";
        if (p.endsWith(".xml")) return "application/xml";
        return "application/octet-stream";
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean handleDeepLink(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data == null) return false;
        if (!"picktime".equals(data.getScheme())) return false;

        String host = data.getHost();
        if ("open".equals(host)) {
            // 从网页唤醒 App：已在运行时直接切到前台；冷启动时由 onCreate 正常加载首页
            return false;
        }
        if (!"google-auth".equals(host)) return false;

        String token = data.getQueryParameter("token");
        if (token != null && !token.isEmpty()) {
            webView.loadUrl(HOME_URL + "?google=1&token=" + Uri.encode(token) + "&app=" + APP_TOKEN);
        } else {
            webView.loadUrl(HOME_URL + "?google_error=1&app=" + APP_TOKEN);
        }
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!handleDeepLink(intent) && webView != null) {
            // 从外部返回时保持在当前页面
            webView.onResume();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_INSTALL_PERMISSION) {
            if (pendingInstallApk != null) {
                boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                        || getPackageManager().canRequestPackageInstalls();
                if (allowed) {
                    fireInstallIntent(pendingInstallApk);
                } else {
                    Toast.makeText(this, "未允许安装应用，已改用浏览器下载", Toast.LENGTH_LONG).show();
                    openExternal(Uri.parse(APK_URL));
                }
                pendingInstallApk = null;
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_PERM_CAMERA) {
            if (pendingPermissionRequest != null) {
                boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
                if (granted) pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
                else pendingPermissionRequest.deny();
                pendingPermissionRequest = null;
            }
            return;
        }
        if (requestCode == REQ_PERM_LOCATION) {
            if (pendingGeoCallback != null) {
                boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
                pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
                pendingGeoCallback = null;
                pendingGeoOrigin = null;
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressed < 2000) {
            super.onBackPressed();
        } else {
            lastBackPressed = now;
            Toast.makeText(this, "再按一次退出拾光", Toast.LENGTH_SHORT).show();
        }
    }

    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(VERSION_URL + "?t=" + System.currentTimeMillis());
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("User-Agent", "PickTimeApp");
                if (connection.getResponseCode() != 200) return;

                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONObject info = new JSONObject(sb.toString());
                int latestCode = info.optInt("versionCode", BuildConfig.VERSION_CODE);
                String latestName = info.optString("versionName", "");
                String remoteWebVersion = info.optString("webVersion", "");

                // 线上网页资源包与本地不一致：本次会话全部走网络，保证用户看到最新内容
                if (!remoteWebVersion.isEmpty() && !remoteWebVersion.equals(BuildConfig.WEB_VERSION)) {
                    useLocalAssets = false;
                    if (!reloadedForWebVersion) {
                        reloadedForWebVersion = true;
                        runOnUiThread(() -> {
                            if (webView != null) webView.reload();
                        });
                    }
                }

                if (latestCode > BuildConfig.VERSION_CODE) {
                    runOnUiThread(() -> showUpdateDialog(latestName));
                }
            } catch (Exception ignored) {
                // 静默失败，不打扰使用
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "picktime-update-check").start();
    }

    private void showUpdateDialog(String versionName) {
        if (isFinishing() || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed())) {
            return;
        }
        if (updateDialog != null && updateDialog.isShowing()) return;

        final Dialog dialog = new Dialog(this, R.style.AppDialog);
        dialog.setContentView(R.layout.dialog_update);
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnCancelListener(d -> updateDownloadCancelled = true);

        final TextView title = dialog.findViewById(R.id.updateTitle);
        final TextView message = dialog.findViewById(R.id.updateMessage);
        final ProgressBar progress = dialog.findViewById(R.id.updateProgress);
        final TextView status = dialog.findViewById(R.id.updateStatus);
        final TextView later = dialog.findViewById(R.id.updateLater);
        final TextView updateNow = dialog.findViewById(R.id.updateNow);

        String suffix = (versionName == null || versionName.isEmpty()) ? "" : " v" + versionName;
        title.setText("发现新版本" + suffix);
        message.setText("更新后体验最新功能，安装包约 7 MB，覆盖安装不会丢失数据。");

        later.setOnClickListener(v -> {
            updateDownloadCancelled = true;
            dialog.dismiss();
        });
        updateNow.setOnClickListener(v -> {
            updateDownloadCancelled = false;
            updateNow.setEnabled(false);
            updateNow.setAlpha(0.6f);
            later.setText("取消");
            progress.setVisibility(View.VISIBLE);
            progress.setProgress(0);
            status.setVisibility(View.VISIBLE);
            status.setText("正在准备下载…");
            startUpdateDownload(versionName, dialog, progress, status, updateNow);
        });

        dialog.setOnDismissListener(d -> updateDialog = null);

        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            DisplayMetrics dm = getResources().getDisplayMetrics();
            window.setLayout((int) (dm.widthPixels * 0.88), ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        updateDialog = dialog;
        dialog.show();
    }

    private void startUpdateDownload(String versionName, Dialog dialog, ProgressBar progress,
                                     TextView status, TextView updateNow) {
        new Thread(() -> {
            File dir = getUpdateDir();
            if (dir == null) {
                runOnUiThread(() -> onDownloadFailed(status, updateNow));
                return;
            }
            String name = "PickTime-" + (versionName == null || versionName.isEmpty() ? "latest" : versionName) + ".apk";
            File apkFile = new File(dir, name);
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(APK_URL).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", "PickTimeApp");
                if (connection.getResponseCode() != 200) throw new IOException("bad status");

                int total = connection.getContentLength();
                long read = 0;
                long lastUpdate = 0;
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(apkFile)) {
                    byte[] buffer = new byte[16384];
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        if (updateDownloadCancelled) break;
                        out.write(buffer, 0, n);
                        read += n;
                        long now = System.currentTimeMillis();
                        if (now - lastUpdate > 250) {
                            lastUpdate = now;
                            final int pct = total > 0 ? (int) (read * 100 / total) : -1;
                            final long current = read;
                            final int all = total;
                            runOnUiThread(() -> {
                                if (pct >= 0) progress.setProgress(pct);
                                status.setText("正在下载 " + formatSize(current)
                                        + (all > 0 ? " / " + formatSize(all) : "")
                                        + (pct >= 0 ? "（" + pct + "%）" : ""));
                            });
                        }
                    }
                }
                if (updateDownloadCancelled) {
                    apkFile.delete();
                    return;
                }
                if (read <= 0) throw new IOException("empty file");

                runOnUiThread(() -> {
                    dialog.dismiss();
                    installApk(apkFile);
                });
            } catch (Exception e) {
                apkFile.delete();
                runOnUiThread(() -> onDownloadFailed(status, updateNow));
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "picktime-update-download").start();
    }

    private void onDownloadFailed(TextView status, TextView updateNow) {
        status.setText("下载失败，请检查网络后重试");
        updateNow.setEnabled(true);
        updateNow.setAlpha(1f);
    }

    private String formatSize(long bytes) {
        if (bytes >= 1024 * 1024) return String.format(java.util.Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0);
        return Math.max(1, bytes / 1024) + " KB";
    }

    private File getUpdateDir() {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        if (base == null) return null;
        File dir = new File(base, "update");
        if (!dir.exists() && !dir.mkdirs()) return null;
        return dir;
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstallApk = apk;
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(intent, REQ_INSTALL_PERMISSION);
                Toast.makeText(this, "请允许「拾光」安装应用，然后返回", Toast.LENGTH_LONG).show();
                return;
            } catch (Exception ignored) {
                // 部分机型无此设置页，直接尝试安装
            }
        }
        fireInstallIntent(apk);
    }

    private void fireInstallIntent(File apk) {
        Uri uri = Uri.parse("content://" + ApkProvider.AUTHORITY + "/" + apk.getName());
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (Exception e) {
            // 兜底：跳系统浏览器下载安装
            openExternal(Uri.parse(APK_URL));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (popupWebView != null) {
            popupWebView.destroy();
            popupWebView = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
