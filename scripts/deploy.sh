#!/usr/bin/env bash
# Deploy wz-monitor to a remote VPS.
#
# Usage:
#   SSH_PASS=... ./scripts/deploy.sh root@your.server.ip
# or with a key (no SSH_PASS):
#   ./scripts/deploy.sh root@your.server.ip
#
# Requires: rsync, ssh (and sshpass when SSH_PASS is set).
# Tested on Ubuntu 24.04. Needs Node.js >= 20 and apt for chromium deps.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 user@host" >&2
  echo "  e.g.  ./scripts/deploy.sh root@1.2.3.4" >&2
  echo "  set SSH_PASS env var to use password auth via sshpass" >&2
  exit 1
fi

HOST_ARG="$1"
HOST="${HOST_ARG#*@}"
USER="${HOST_ARG%@*}"
[ "$USER" = "$HOST_ARG" ] && USER=root

REMOTE_DIR=/opt/wz-monitor
STATE_DIR=/var/lib/wz-monitor

if [ -n "${SSH_PASS:-}" ]; then
  SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
  RSYNC_E="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
  export SSHPASS="$SSH_PASS"
  SSH_ENV="SSHPASS=$SSH_PASS"
else
  SSH="ssh"
  RSYNC_E="ssh"
fi

run() { $SSH -o BatchMode=no "$USER@$HOST" "$1"; }

echo "==> Provisioning $USER@$HOST ..."
run "set -e
  if ! command -v node >/dev/null 2>&1 || [ \$(node -v | sed 's/[^0-9]*//;s/\..*//') -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0
  id -u wz >/dev/null 2>&1 || useradd -r -m -d $STATE_DIR -s /usr/sbin/nologin wz
  mkdir -p $REMOTE_DIR $STATE_DIR
  chown -R wz:wz $STATE_DIR
"

echo "==> Syncing code to $REMOTE_DIR ..."
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude .env.local \
  --exclude storageState.json --exclude seen.json --exclude .playwright-mcp \
  --exclude '.DS_Store' \
  -e "$RSYNC_E" ./ "$USER@$HOST:$REMOTE_DIR/"

echo "==> Installing deps + chromium on remote ..."
run "set -e
  cd $REMOTE_DIR
  npm install --omit=dev
  HOME=$STATE_DIR npx --yes playwright install chromium
  chown -R wz:wz $REMOTE_DIR
"

echo "==> Uploading secrets (.env, storageState.json) ..."
if [ -f .env.server ]; then
  rsync -az -e "$RSYNC_E" .env.server "$USER@$HOST:$REMOTE_DIR/.env"
else
  rsync -az -e "$RSYNC_E" .env.local "$USER@$HOST:$REMOTE_DIR/.env"
fi
rsync -az -e "$RSYNC_E" storageState.json "$USER@$HOST:$STATE_DIR/storageState.json"

run "set -e
  chmod 600 $REMOTE_DIR/.env $STATE_DIR/storageState.json
  chown wz:wz $REMOTE_DIR/.env $STATE_DIR/storageState.json
  # Make sure paths in .env match the server layout
  sed -i 's|^STORAGE_STATE_PATH=.*|STORAGE_STATE_PATH=$STATE_DIR/storageState.json|' $REMOTE_DIR/.env
  sed -i 's|^SEEN_STORE_PATH=.*|SEEN_STORE_PATH=$STATE_DIR/seen.json|' $REMOTE_DIR/.env
"

echo "==> Installing systemd unit ..."
rsync -az -e "$RSYNC_E" systemd/wz-monitor.service "$USER@$HOST:/etc/systemd/system/wz-monitor.service"
run "systemctl daemon-reload && systemctl enable wz-monitor && systemctl restart wz-monitor && sleep 3 && systemctl status wz-monitor --no-pager | head -10"

echo "==> Done. Tail logs with:"
echo "    ssh $USER@$HOST 'journalctl -u wz-monitor -f'"
