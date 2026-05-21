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

# ── Auto-clean stale downloads ───────────────────────────────────────────────
DOWNLOADS_DIR="$(dirname "$0")/downloads"
mkdir -p "$DOWNLOADS_DIR"

# Always delete .part/.temp files — these are always failed/interrupted junk
PARTS=$(find "$DOWNLOADS_DIR" \( -name "*.part" -o -name "*.temp.mp4" \) 2>/dev/null)
if [ -n "$PARTS" ]; then
  echo "  🧹  Removing failed partial downloads..."
  find "$DOWNLOADS_DIR" -name "*.part" -delete 2>/dev/null
  find "$DOWNLOADS_DIR" -name "*.temp.mp4" -delete 2>/dev/null
  echo "  ✅  Cleaned up."
  echo ""
fi

# Delete completed downloads older than 3 days (should be on iPhone by then)
OLD=$(find "$DOWNLOADS_DIR" -name "*.mp4" -mtime +3 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "  🗑️   Removing downloads older than 3 days..."
  find "$DOWNLOADS_DIR" -name "*.mp4" -mtime +3 -delete 2>/dev/null
  find "$DOWNLOADS_DIR" -name "*.m4a" -mtime +3 -delete 2>/dev/null
  find "$DOWNLOADS_DIR" -name "*.json" -mtime +3 -delete 2>/dev/null
  FREE_BYTES=$(df -k / | tail -1 | awk '{print $4}')
  FREE_GB=$((FREE_BYTES / 1024 / 1024))
  echo "  ✅  Done. Free space now: ~${FREE_GB} GB"
  echo ""
fi


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
