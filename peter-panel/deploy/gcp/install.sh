#!/usr/bin/env bash
# Installs (or updates) Peter Panel on a Debian/Ubuntu server and runs it as an
# always-on service that restarts itself after crashes and reboots.
#
# First time: upload `.env` and `google-service-account.json` to your home folder on the
# server (SSH-in-browser → UPLOAD FILE), then run:
#   curl -fsSL https://raw.githubusercontent.com/aditya-mahendran/Aditya-Mahendran/claude/peter-panel-slack-app-nnu1ko/peter-panel/deploy/gcp/install.sh | sudo bash
# To update to the latest code later, run the same command again.
set -euo pipefail

REPO="${REPO:-https://github.com/aditya-mahendran/Aditya-Mahendran.git}"
BRANCH="${BRANCH:-claude/peter-panel-slack-app-nnu1ko}"
DIR=/opt/peter-panel
APP="$DIR/peter-panel"
SERVICE=peter-panel
RUN_AS=peterpanel
UPLOADS="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

echo "==> Swap (the free server has 1 GB of memory; this keeps installs from running out)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Node.js 22 and git"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git >/dev/null
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "    $("$NODE_BIN" --version) at $NODE_BIN"

echo "==> App user"
id "$RUN_AS" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$RUN_AS"

echo "==> Code ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
git config --global --add safe.directory "$DIR"

echo "==> Secrets"
mkdir -p "$APP/data"
if [ -f "$UPLOADS/.env" ]; then
  mv "$UPLOADS/.env" "$APP/.env"
  echo "    moved .env into place"
fi
if [ -f "$UPLOADS/google-service-account.json" ]; then
  mv "$UPLOADS/google-service-account.json" "$APP/data/google-service-account.json"
  echo "    moved google-service-account.json into place"
fi
[ -f "$APP/.env" ] || { echo "Missing .env: upload it to your home folder and run this again." >&2; exit 1; }
if grep -q '^STORE=sheets' "$APP/.env" && ! grep -q '^GOOGLE_SERVICE_ACCOUNT_JSON=.' "$APP/.env" && [ ! -f "$APP/data/google-service-account.json" ]; then
  echo "Missing google-service-account.json: upload it to your home folder and run this again." >&2
  exit 1
fi
# The laptop's .env may have Windows line endings.
sed -i 's/\r$//' "$APP/.env"
chown -R "$RUN_AS:$RUN_AS" "$DIR"
chmod 600 "$APP/.env"
[ -f "$APP/data/google-service-account.json" ] && chmod 600 "$APP/data/google-service-account.json"

echo "==> Install and build"
cd "$APP"
sudo -u "$RUN_AS" -H npm ci --no-audit --no-fund --loglevel=error
sudo -u "$RUN_AS" -H npm run build --silent

echo "==> Service"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Peter Panel Slack app
Wants=network-online.target
After=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=TZ=America/Chicago
ExecStart=$NODE_BIN dist/src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"
sleep 8
systemctl --no-pager --lines=8 status "$SERVICE" || true

echo
echo "Done. Peter Panel is running and starts by itself after a reboot."
echo "Live logs:   sudo journalctl -u $SERVICE -f"
echo "Update:      run the same curl … | sudo bash command again"
