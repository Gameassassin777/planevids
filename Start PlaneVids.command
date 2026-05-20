#!/bin/bash

# ── PlaneVids Launcher ───────────────────────────────────────────────────────
# Double-click this file in Finder to start PlaneVids.
# A Terminal window will open, the server will start, and Safari will open.

# Change into the directory where this script lives (handles any location)
cd "$(dirname "$0")"

clear
echo ""
echo "  ✈️  PlaneVids"
echo "  ─────────────────────────────────────"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "  📦 First run — installing dependencies..."
  npm install --silent
  echo "  ✅ Done."
  echo ""
fi

# Open Safari after 2 seconds (server needs a moment to bind)
(sleep 2 && open -a Safari http://localhost:3000) &

echo "  🚀 Starting server..."
echo "  ─────────────────────────────────────"
echo ""

# Start the server (blocking — keep terminal open)
node server.js
