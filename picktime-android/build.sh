#!/usr/bin/env bash
# 拾光 Android 打包脚本
# 用法: ./build.sh [versionCode] [versionName]
#   例: ./build.sh 2 1.0.1
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="/home/ubuntu/Picktime"
DEPLOY_DIR="$WEB_DIR/download"

VERSION_CODE="${1:-1}"
VERSION_NAME="${2:-1.0.0}"
APK_NAME="PickTime-${VERSION_NAME}.apk"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

GRADLE_BIN="${GRADLE_BIN:-/opt/gradle-8.7/bin/gradle}"
if [ ! -x "$GRADLE_BIN" ]; then
  GRADLE_BIN="$PROJECT_DIR/gradlew"
fi

echo "==> [1/4] 同步网页资源 -> assets/www"
mkdir -p "$PROJECT_DIR/app/src/main/assets/www"
rsync -a --delete \
  --exclude 'android/' \
  --exclude 'download/' \
  --exclude 'sw.js' \
  --exclude 'font-preview.html' \
  --exclude '*.zip' \
  --exclude 'images/stickers' \
  "$WEB_DIR/" "$PROJECT_DIR/app/src/main/assets/www/"

# 资源包版本戳：网页内容有变化时变化，App 用它判断本地资源是否过期
WEB_VERSION=$(cd "$WEB_DIR" && find . -type f \
  -not -path './android/*' -not -path './download/*' \
  -not -name 'sw.js' -not -name 'font-preview.html' -not -name '*.zip' \
  -print0 | sort -z | xargs -0 md5sum | md5sum | cut -c1-12)
echo "    webVersion = $WEB_VERSION"

echo "==> [2/4] 构建 release APK (versionCode=$VERSION_CODE, versionName=$VERSION_NAME)"
cd "$PROJECT_DIR"
"$GRADLE_BIN" --no-daemon assembleRelease \
  -PversionCode="$VERSION_CODE" -PversionName="$VERSION_NAME" -PwebVersion="$WEB_VERSION"

APK_SRC="$PROJECT_DIR/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "构建失败：未找到 $APK_SRC" >&2
  exit 1
fi

echo "==> [3/4] 校验签名"
APKSIGNER="$ANDROID_HOME/build-tools/34.0.0/apksigner"
if [ -x "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK_SRC" | head -4
fi

echo "==> [4/4] 发布到 $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
cp "$APK_SRC" "$DEPLOY_DIR/$APK_NAME"
cp "$APK_SRC" "$DEPLOY_DIR/PickTime.apk"

SIZE=$(stat -c %s "$DEPLOY_DIR/PickTime.apk")
cat > "$DEPLOY_DIR/version.json" <<EOF
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "webVersion": "$WEB_VERSION",
  "apk": "/download/PickTime.apk",
  "apkName": "$APK_NAME",
  "size": $SIZE,
  "minAndroid": "6.0",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "完成:"
echo "  $DEPLOY_DIR/PickTime.apk  ($((SIZE / 1024 / 1024)) MB)"
echo "  $DEPLOY_DIR/$APK_NAME"
echo "  $DEPLOY_DIR/version.json"
