#!/usr/bin/env bash
# ============================================================
# 拾光 PickTime v1.2.7 一键部署脚本
# 适用：Ubuntu 22.04 / 24.04
# 用法：把压缩包解压到 /home/ubuntu 后执行
#       bash /home/ubuntu/deploy.sh
# 说明：Node 运行时、Python 环境、模型、依赖都已随包附带；
#       目标机只需系统自带的 python3.12、MySQL、nginx。
# ============================================================
set -u
ROOT="/home/ubuntu"
NODE_BIN="$ROOT/.nvm/versions/node/v24.16.0/bin"
VENV_PY="$ROOT/yolo-env/bin/python"
export PATH="$NODE_BIN:$PATH"
DB_USER="picktime"
DB_PASS="${PICKTIME_DB_PASSWORD:-change-me-before-deploy}"
DB_NAME="picktime"

say()  { printf "\n\033[1;32m==> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m! %s\033[0m\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SCRIPT_DIR" != "$ROOT" ]; then
  warn "脚本当前在 $SCRIPT_DIR，但 Node/Python 环境按 /home/ubuntu 设计，请把压缩包解压到 /home/ubuntu 后再执行"
fi

say "1/6 检查环境"
if [ -x "$NODE_BIN/node" ]; then ok "Node: $($NODE_BIN/node -v)（随包附带）"; else warn "未找到内置 Node：$NODE_BIN"; fi
if [ -x "$VENV_PY" ] && "$VENV_PY" -c "import torch" >/dev/null 2>&1; then
  ok "Python 环境 yolo-env 可用"
else
  warn "yolo-env 不可用：目标机需要 python3.12（Ubuntu 24.04 自带）。安装后可重建：python3.12 -m venv yolo-env"
fi
command -v mysql >/dev/null && ok "MySQL 已安装" || warn "未安装 MySQL，请先执行：sudo apt install -y mysql-server"
command -v nginx >/dev/null && ok "nginx 已安装" || warn "未安装 nginx，请先执行：sudo apt install -y nginx"

say "2/6 导入数据库（users / records）"
if command -v mysql >/dev/null; then
  if sudo -n mysql -e "SELECT 1" >/dev/null 2>&1; then
    sudo mysql -e "CREATE DATABASE IF NOT EXISTS $DB_NAME DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"
    mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$ROOT/picktime-db.sql" && ok "数据已导入"
  else
    warn "sudo mysql 免密登录不可用，请手动建库后导入：mysql -u$DB_USER -p$DB_PASS $DB_NAME < $ROOT/picktime-db.sql"
  fi
fi

say "3/6 配置 nginx（8050 + 443）"
if command -v nginx >/dev/null; then
  if [ -f /etc/letsencrypt/live/picktime.store/fullchain.pem ]; then
    sudo cp "$ROOT/nginx-picktime.store.conf" /etc/nginx/conf.d/picktime.store.conf
    ok "使用完整配置（含域名 443）"
  else
    sudo cp "$ROOT/nginx-picktime-8050.conf" /etc/nginx/conf.d/picktime.store.conf
    ok "未检测到域名证书：已只启用 8050 端口，用 http://<服务器IP>:8050 访问"
    echo "     （配好域名与证书后，把 nginx-picktime.store.conf 复制过去即可启用 443）"
  fi
  if sudo nginx -t 2>/dev/null; then
    sudo systemctl reload nginx && ok "nginx 已加载"
  else
    warn "nginx 配置校验失败，请检查后手动执行：sudo nginx -t && sudo systemctl reload nginx"
  fi
fi

say "4/6 启动 5001 U2NET 抠图服务"
if [ -x "$NODE_BIN/pm2" ] && [ -x "$VENV_PY" ]; then
  pm2 delete purse-bg >/dev/null 2>&1 || true
  pm2 start "$ROOT/purse-v2.5.3/bg_service.py" --name purse-bg --interpreter "$VENV_PY" -- --port 5001 --host 127.0.0.1 >/dev/null
  ok "purse-bg 已启动（5001）"
else
  warn "手动启动：$VENV_PY $ROOT/purse-v2.5.3/bg_service.py --port 5001 --host 127.0.0.1 &"
fi

say "5/6 启动 5002 账号服务 与 5003 识别服务"
if [ -x "$NODE_BIN/pm2" ]; then
  (cd "$ROOT/picktime-sms" && pm2 start ecosystem.config.js >/dev/null)
  (cd "$ROOT/food-ai" && pm2 start ecosystem.config.js >/dev/null)
  pm2 save >/dev/null 2>&1
  ok "picktime-sms（5002）、food-ai（5003）已启动"
fi

say "6/6 服务状态"
[ -x "$NODE_BIN/pm2" ] && pm2 ls
echo ""
echo "完成！"
echo "  网页访问：   http://<服务器IP>:8050/   （域名访问需自行改 nginx 里的域名与证书）"
echo "  识别服务：   curl http://127.0.0.1:5003/health"
echo "  重启服务：   $NODE_BIN/pm2 restart all"
