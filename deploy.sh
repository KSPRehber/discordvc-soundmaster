#!/usr/bin/env bash
# Bootstrap for a fresh Debian/Ubuntu server. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/KSPRehber/discordvc-soundmaster/main/deploy.sh | bash
set -euo pipefail

APP_DIR=/opt/discordvc-soundmaster
REPO=https://github.com/KSPRehber/discordvc-soundmaster.git

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg git curl ca-certificates python3 >/dev/null

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  echo "==> Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node --version), npm $(npm --version)"

echo "==> Cloning ${REPO}"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> Installing npm dependencies"
npm install --no-audit --no-fund
npm rebuild >/dev/null

echo "==> Downloading yt-dlp"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
chmod +x yt-dlp

if [ ! -f .env ]; then
  if [ -t 0 ]; then
    echo "==> Configuration (.env)"
    read -rp "Discord bot token: " discord_token
    read -rp "ElevenLabs API key: " eleven_key
    printf 'DISCORD_TOKEN=%s\nELEVENLABS_API_KEY=%s\n' "$discord_token" "$eleven_key" > .env
    chmod 600 .env
  else
    # stdin is the piped script; can't prompt. Finish setup manually.
    cp .env.example .env
    chmod 600 .env
    echo "!! No terminal for input: fill in ${APP_DIR}/.env, then run:"
    echo "   systemctl restart discord-tts"
  fi
fi

echo "==> Installing systemd service"
cat > /etc/systemd/system/discord-tts.service <<EOF
[Unit]
Description=Discord TTS + music bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=5
# Don't thrash if the token is wrong
StartLimitIntervalSec=120
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now discord-tts

echo
echo "Done. Useful commands:"
echo "  journalctl -u discord-tts -f   # live logs"
echo "  systemctl restart discord-tts  # restart after editing .env"
