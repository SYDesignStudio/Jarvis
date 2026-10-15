#!/bin/bash
# Builds /Applications/JARVIS.app: one icon that mounts the shares, starts the brain and
# the face if they are not running, and opens JARVIS in its own Chrome window.
set -e
JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# The main Applications folder when it is writable (it is, for an admin user), else the personal one.
if [ -w /Applications ]; then APP="/Applications/JARVIS.app"; else APP="$HOME/Applications/JARVIS.app"; fi
# A copy left in the other place would go stale.
[ "$APP" = "/Applications/JARVIS.app" ] && rm -rf "$HOME/Applications/JARVIS.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>JARVIS</string>
  <key>CFBundleDisplayName</key><string>JARVIS</string>
  <key>CFBundleIdentifier</key><string>uk.co.sydesignstudio.jarvis</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>JARVIS</string>
  <key>CFBundleIconFile</key><string>JARVIS</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/JARVIS" <<LAUNCH
#!/bin/bash
# Launched from Finder, so PATH is bare: add Homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd "$JARVIS_DIR"
LOG="\$HOME/Library/Logs/jarvis.log"
echo "--- \$(date) JARVIS.app opened" >> "\$LOG"
bash scripts/mac/mount.sh >> "\$LOG" 2>&1 || true
if ! curl -s -o /dev/null http://localhost:5173; then
  nohup npm start >> "\$LOG" 2>&1 &
fi
for i in \$(seq 1 90); do curl -s -o /dev/null http://localhost:5173 && break; sleep 1; done
# Its own Chrome profile: the microphone permission is asked once and kept.
open -na "Google Chrome" --args --app=http://localhost:5173 \
  --user-data-dir="\$HOME/Library/Application Support/JARVIS" \
  --autoplay-policy=no-user-gesture-required
LAUNCH
chmod +x "$APP/Contents/MacOS/JARVIS"

# Icon, if the face has a PNG we can turn into one.
# Icon: the face's favicon.svg, rasterised by Quick Look (sips cannot read SVG) and packed with iconutil.
if [ -f "$JARVIS_DIR/public/favicon.svg" ] && command -v iconutil >/dev/null; then
  TMP="$(mktemp -d)"; SET="$TMP/JARVIS.iconset"; mkdir -p "$SET"
  qlmanage -t -s 1024 -o "$TMP" "$JARVIS_DIR/public/favicon.svg" >/dev/null 2>&1 || true
  if [ -f "$TMP/favicon.svg.png" ]; then
    for s in 16 32 128 256 512; do
      sips -z $s $s "$TMP/favicon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null 2>&1
      sips -z $((s*2)) $((s*2)) "$TMP/favicon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$SET" -o "$APP/Contents/Resources/JARVIS.icns" 2>/dev/null || true
  fi
fi
touch "$APP"
echo "  made $APP"
