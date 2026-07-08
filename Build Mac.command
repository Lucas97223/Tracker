#!/bin/bash
# Double-click this file on a Mac to build the macOS installer (.dmg).
#
# One-time setup on the Mac (only the first time):
#   1. Install Node.js LTS from https://nodejs.org (download the .pkg, click through)
#   2. Open Terminal and run:
#        chmod +x "/path/to/expense-tracker/Build Mac.command"
#      (replace the path with where you put the folder)
#   3. Edit .env in this folder so it has your real Supabase URL + anon key
#
# After that, just double-click this file whenever you want to rebuild.
# The .dmg appears in the ./release/ folder when it's done.

set -e
cd "$(dirname "$0")"

step() { echo ""; echo "=== $1 ==="; }
fail() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"Build Mac Installer\" with icon stop"
  exit 1
}
ok() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"Build Mac Installer\""
}

# ---- 1. Node.js must be installed ----
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed.\n\nDownload the LTS installer from https://nodejs.org and run it, then double-click this file again."
fi
step "Node.js detected: $(node --version)"

# ---- 2. .env must exist and look real ----
if [ ! -f .env ]; then
  cp .env.example .env
  open -e .env 2>/dev/null || open .env
  fail ".env was missing — a blank one was just created and opened for editing.\n\nFill in your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (same values you used on Windows), save the file, then double-click this script again."
fi
if grep -q "YOUR-PROJECT\|YOUR_ANON_KEY" .env; then
  open -e .env 2>/dev/null || open .env
  fail ".env still has placeholder values.\n\nReplace YOUR-PROJECT and YOUR_ANON_KEY with your real Supabase URL and anon key, save the file, then double-click this script again."
fi
step ".env looks valid"

# ---- 3. Install dependencies if missing ----
if [ ! -d node_modules ]; then
  step "Installing dependencies (one-time, ~2 minutes)…"
  npm install --no-audit --no-fund
fi

# ---- 4. Build the installer ----
step "Building macOS installer…"
npm run electron:installer:mac

# ---- 5. Show the result ----
ARM_DMG=$(ls -1 release/*-arm64.dmg 2>/dev/null | head -1 || true)
X64_DMG=$(ls -1 release/*.dmg 2>/dev/null | grep -v arm64 | head -1 || true)

MSG="Build complete. The installer(s) are in the release/ folder.\n\n"
[ -n "$ARM_DMG" ] && MSG="${MSG}• Apple Silicon: $(basename "$ARM_DMG")\n"
[ -n "$X64_DMG" ] && MSG="${MSG}• Intel: $(basename "$X64_DMG")\n"
MSG="${MSG}\nDouble-click the .dmg, drag the app to Applications, then right-click → Open the first time."

open ./release 2>/dev/null || true
ok "$MSG"
