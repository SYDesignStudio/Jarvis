#!/bin/bash
# JARVIS on the MacBook — one-time setup. From the jarvis folder:  bash scripts/mac/setup.sh
# Installs Node, Python, Chrome and Claude Code, builds the Mac's own node_modules,
# and makes a Python with mlx-whisper for call transcription on the M5.
set -e
cd "$(dirname "$0")/../.."
echo "JARVIS Mac setup in $(pwd)"

if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
brew list node >/dev/null 2>&1 || brew install node
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
[ -d "/Applications/Google Chrome.app" ] || brew install --cask google-chrome
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

# Native modules are built per machine: never copy node_modules from the PC.
npm install

# Whisper on Apple silicon, in its own venv so Homebrew's Python stays untouched.
if [ ! -x .venv-mac/bin/python ]; then
  python3.12 -m venv .venv-mac
fi
.venv-mac/bin/pip install --quiet --upgrade pip mlx-whisper || echo "  mlx-whisper did not install; call transcription will be off on the Mac."

# .env.local: copied from the PC by Salman, then made Mac-shaped here.
if [ -f .env.local ]; then
  grep -q '^JARVIS_SATELLITE=' .env.local || printf '\n# The PC owns Telegram, the inbox watchers and background jobs.\nJARVIS_SATELLITE=1\n' >> .env.local
  grep -q '^JARVIS_PYTHON=' .env.local || printf 'JARVIS_PYTHON=%s/.venv-mac/bin/python\n' "$(pwd)" >> .env.local
  # A Windows working directory means nothing here; the Mac works out its own.
  sed -i '' '/^JARVIS_CWD=[A-Za-z]:/d' .env.local
  echo "  .env.local is set for the Mac."
else
  echo
  echo "  Now copy .env.local from the PC into $(pwd) and run this script again."
fi

bash scripts/mac/make-app.sh
echo
echo "Done. Sign in to Claude once:  claude"
echo "Then open JARVIS from Launchpad, or:  open ~/Applications/JARVIS.app"
