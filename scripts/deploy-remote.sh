#!/usr/bin/env bash
# 一键部署到云服务器（Ubuntu 22.04/24.04，root + SSH 密钥登录）。
#
# 设计原则：服务器只做「装 Node 二进制 + 装生产依赖 + 跑服务」三件事。
# 构建（tsc / vite）全部在本地完成，上传的 dist 是构建产物 —— 因为目标机只有 1.6G 内存，
# 在上面跑 apt/dpkg 或 tsc 极易把 sshd 一起拖死（本脚本第一版就是这么翻车的）。
#
# 用法：
#   bash scripts/deploy-remote.sh                      # 用 ~/.ssh/config 里的 my-aliyun
#   DEPLOY_HOST=root@1.2.3.4 bash scripts/deploy-remote.sh
#   NODE_VERSION=24.20.0 DEPLOY_SERVER_NAME=game.foo.com bash scripts/deploy-remote.sh
#
# 首次执行会：装 Node → 装 pnpm → 装生产依赖 → 写 systemd 单元 → 写 nginx 站点 → 起服务。
# 之后的执行只做：上传 → 装依赖 → 重启服务 → 刷新静态文件（幂等）。
set -euo pipefail

HOST="${DEPLOY_HOST:-my-aliyun}"
APP_DIR="${DEPLOY_DIR:-/root/Projects/colyseus-fps}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/var/www/fps}"
NODE_VERSION="${NODE_VERSION:-24.20.0}"
PNPM_VERSION="${PNPM_VERSION:-12.16.1}"
SERVER_PORT="${SERVER_PORT:-2567}"
SERVICE_NAME="fps-server"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 房间名从 shared 里读，避免脚本里出现第二份真相
ROOM_NAME="$(sed -n 's/.*DEFAULT_ROOM_NAME: string = "\([^"]*\)".*/\1/p' packages/shared/src/index.ts | head -1)"
ROOM_NAME="${ROOM_NAME:-fps_battle}"

# 站点域名/IP：默认取 ssh config 里的 HostName，保证和部署目标一致
SERVER_NAME="${DEPLOY_SERVER_NAME:-$(ssh -G "$HOST" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')}"
SERVER_NAME="${SERVER_NAME:-$HOST}"

info() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
info "0/7 检查前置条件（host=$HOST, 站点=$SERVER_NAME）"
command -v pnpm >/dev/null || fail "本地缺少 pnpm"
command -v ssh  >/dev/null || fail "本地缺少 ssh"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "echo ok" >/dev/null 2>&1 \
  || fail "无法免密登录 $HOST。先在服务器恢复 SSH，并把本机公钥加进 ~/.ssh/authorized_keys"

# ---------- 1. 本地构建 ----------
info "1/7 本地构建（shared → server → client）"
pnpm build

# ---------- 2. 打包上传 ----------
info "2/7 打包并上传源码 + 构建产物"
# 注意：Windows 下 tar 会把 "C:\..." 里的冒号当成远程主机名，
# 因此压缩包只用相对路径（tmp/ 已在 .gitignore 里），且加 --force-local 兜底。
mkdir -p tmp
trap 'rm -f tmp/fps-deploy.tgz' EXIT
tar czf tmp/fps-deploy.tgz --force-local \
  --exclude='node_modules' --exclude='.git' --exclude='.workbuddy' \
  --exclude='*.tsbuildinfo' --exclude='coverage' --exclude='logs' \
  package.json pnpm-lock.yaml pnpm-workspace.yaml \
  packages apps
scp -q tmp/fps-deploy.tgz "$HOST:/tmp/fps-deploy.tgz"

# ---------- 3. 服务器侧：解包 + Node + pnpm + 依赖 + 服务 + nginx ----------
info "3/7 在服务器上解包并安装运行时（不改动系统包管理器）"
ssh "$HOST" "APP_DIR='$APP_DIR' WEB_ROOT='$WEB_ROOT' NODE_VERSION='$NODE_VERSION' \
PNPM_VERSION='$PNPM_VERSION' SERVER_PORT='$SERVER_PORT' SERVER_NAME='$SERVER_NAME' \
SERVICE_NAME='$SERVICE_NAME' bash -s" <<'REMOTE'
set -euo pipefail

step() { printf '\033[36m   - %s\033[0m\n' "$1"; }

# 4.1 解包（保留服务器上的 data/ 与 logs/，只替换代码）
step "解包到 $APP_DIR"
mkdir -p "$APP_DIR/logs" "$APP_DIR/apps/server/data"
rm -rf "$APP_DIR/apps" "$APP_DIR/packages"
tar xzf /tmp/fps-deploy.tgz -C "$APP_DIR"
rm -f /tmp/fps-deploy.tgz

# 4.2 Node：优先用官方二进制包（xz 解压，零 dpkg 依赖），失败再退回 npmmirror 镜像
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
fi

if [ "$node_major" -lt 24 ]; then
  step "安装 Node v$NODE_VERSION 到 /opt/node-v$NODE_VERSION"
  mkdir -p "/opt/node-v$NODE_VERSION"
  ok=0
  for url in \
    "https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"; do
    if curl -fsSL --connect-timeout 15 --max-time 300 "$url" -o /tmp/node.tar.xz; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "Node 下载失败，请检查服务器出网"; exit 1; }
  tar xJf /tmp/node.tar.xz -C "/opt/node-v$NODE_VERSION" --strip-components=1
  rm -f /tmp/node.tar.xz
  for bin in node npm npx; do
    ln -sf "/opt/node-v$NODE_VERSION/bin/$bin" "/usr/local/bin/$bin"
  done
fi
step "node $(node -v)"

# 4.3 pnpm
if ! command -v pnpm >/dev/null 2>&1 || ! pnpm --version | grep -q "^$PNPM_VERSION"; then
  step "安装 pnpm@$PNPM_VERSION"
  npm i -g "pnpm@$PNPM_VERSION" --registry=https://registry.npmmirror.com >/dev/null 2>&1
  ln -sf "/opt/node-v$NODE_VERSION/bin/pnpm" /usr/local/bin/pnpm 2>/dev/null || true
fi
step "pnpm $(pnpm --version)"

# 4.4 只装服务端生产依赖（客户端已被打成静态文件，不需要 three/vite）
step "安装服务端生产依赖"
cd "$APP_DIR"
pnpm install --frozen-lockfile --prod --filter @colyseus-fps/server... \
  --registry=https://registry.npmmirror.com \
  || pnpm install --frozen-lockfile --prod --registry=https://registry.npmmirror.com

# 4.5 systemd 单元（小内存机器加 MemoryMax 保护，避免和 nginx 抢内存被 OOM 连坐）
step "写入 systemd 单元 /etc/systemd/system/$SERVICE_NAME.service"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=Colyseus FPS 权威服务端
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/apps/server
Environment=NODE_ENV=production
Environment=SERVER_HOST=127.0.0.1
Environment=SERVER_PORT=$SERVER_PORT
Environment=LOG_LEVEL=info
Environment=AUDIT_DB_PATH=$APP_DIR/apps/server/data/audit.db
ExecStart=/usr/local/bin/node $APP_DIR/apps/server/dist/index.js
Restart=always
RestartSec=3
MemoryMax=640M
StandardOutput=append:$APP_DIR/logs/server.log
StandardError=append:$APP_DIR/logs/server.err.log

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME" && step "服务已启动（$SERVER_PORT）" \
  || { echo "服务启动失败，查看 journalctl -u $SERVICE_NAME -n 40"; exit 1; }

# 4.6 静态站点
step "发布前端静态文件到 $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete "$APP_DIR/apps/client/dist/" "$WEB_ROOT/"

# 4.7 nginx：独立 server 块（server_name 精确匹配本机 IP，优先于现有 default_server）
step "写入 nginx 站点 /etc/nginx/conf.d/fps.conf"
if [ -f /etc/nginx/conf.d/fps.conf ]; then
  cp /etc/nginx/conf.d/fps.conf "/etc/nginx/conf.d/fps.conf.bak.$(date +%s)"
fi
cat > /etc/nginx/conf.d/fps.conf <<CONF
# 由 scripts/deploy-remote.sh 生成；改了重跑脚本即可
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    root $WEB_ROOT;
    index index.html;

    # Colyseus 的 matchmake 走 HTTP POST、房间走 WebSocket 升级，共用同一前缀
    location /fps-ws/ {
        proxy_pass http://127.0.0.1:$SERVER_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location /assets/ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
CONF
nginx -t >/dev/null 2>&1 || { echo "nginx 配置校验失败，已保留 .bak 备份"; exit 1; }
nginx -s reload
step "nginx 已重载"
REMOTE

# ---------- 4. 健康检查 ----------
info "4/7 健康检查"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://$SERVER_NAME/" || true)"
[ "$code" = "200" ] || fail "首页返回 HTTP $code（期望 200）"

# 用一个真实的 Colyseus 客户端握手，验证 matchmake + WebSocket 反代都通
INFO_JSON="$(curl -s -X POST --max-time 15 \
  -H 'Content-Type: application/json' -d '{}' \
  "http://$SERVER_NAME/fps-ws/matchmake/joinOrCreate/$ROOM_NAME" || true)"
echo "$INFO_JSON" | grep -q '"roomId"' || fail "matchmake 失败：$INFO_JSON"
info "matchmake 正常：$(echo "$INFO_JSON" | head -c 120)…"

# ---------- 5. 收尾 ----------
info "5/7 完成"
echo
echo "  游戏地址：http://$SERVER_NAME/"
echo "  总局地址：http://$SERVER_NAME/fps-ws  （matchmake + WebSocket）"
echo "  服务状态：ssh $HOST systemctl status $SERVICE_NAME"
echo "  实时日志：ssh $HOST journalctl -u $SERVICE_NAME -f"
echo
echo "  提示：服务端绑定 127.0.0.1，只经 nginx 暴露；云安全组无需额外放行端口。"
