#!/bin/bash

# ── PlaneVids Launcher ───────────────────────────────────────────────────────
cd "$(dirname "$0")"

clear
echo ""
echo "  ✈️  PlaneVids"
echo "  ─────────────────────────────────────"

# ── Kill anything already on port 3000 ──────────────────────────────────────
EXISTING=$(lsof -ti:3000 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "  ♻️  Clearing old server on port 3000..."
  echo "$EXISTING" | xargs kill -9 2>/dev/null
  sleep 1
fi

# ── Check disk space (need at least 15 GB free) ──────────────────────────────
FREE_BYTES=$(df -k / | tail -1 | awk '{print $4}')
FREE_GB=$((FREE_BYTES / 1024 / 1024))

echo ""
if [ "$FREE_GB" -lt 8 ]; then
  echo "  ❌  DISK SPACE TOO LOW: Only ~${FREE_GB} GB free on your Mac."
  echo "  Need at least 8 GB free. Free up space then try again."
  echo ""
  read -p "  Press Enter to exit..."
  exit 1
fi

if [ "$FREE_GB" -lt 15 ]; then
  echo "  ⚠️   Only ~${FREE_GB} GB free — use 720p to be safe (1080p needs ~10 GB)."
fi

echo "  💾  Free disk space: ~${FREE_GB} GB — good to go."
echo ""

# ── Update yt-dlp if older than 7 days ──────────────────────────────────────
YTDLP_PATH=$(which yt-dlp)
if [ -n "$YTDLP_PATH" ]; then
  YTDLP_AGE=$(( ( $(date +%s) - $(stat -f %m "$YTDLP_PATH") ) / 86400 ))
  if [ "$YTDLP_AGE" -gt 7 ]; then
    echo "  🔄  Updating yt-dlp (last updated ${YTDLP_AGE} days ago)..."
    pip install -q -U yt-dlp 2>/dev/null && echo "  ✅  yt-dlp updated." || echo "  ⚠️  Update skipped (will still work)."
    echo ""
  fi
fi

# ── Install node_modules if missing ─────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "  📦  First run — installing dependencies..."
  npm install --silent
  echo "  ✅  Done."
  echo ""
fi

# ── Open Safari after 2 seconds ─────────────────────────────────────────────
(sleep 2 && open -a Safari http://localhost:3000) &

echo "  🚀  Starting server..."
echo "  ─────────────────────────────────────"
echo ""

node server.js
