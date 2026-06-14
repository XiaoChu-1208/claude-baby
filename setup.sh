#!/usr/bin/env bash
# Claude Baby — one-shot dependency installer (macOS).
# Installs everything needed to run Claude Baby. Safe to re-run: it skips what
# is already present. Optional components prompt before doing anything heavy.
#
#   ./setup.sh            # interactive
#   ./setup.sh --all      # accept all optional components (incl. ~1.6GB model)
#   ./setup.sh --minimal  # required deps only, skip every optional prompt
#
# This does NOT need sudo. It cannot log you in to Claude or set your API key —
# those last two steps are printed for you to finish by hand.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

MODE="ask"
case "${1:-}" in
  --all) MODE="all" ;;
  --minimal) MODE="minimal" ;;
  "" ) ;;
  * ) echo "Unknown option: $1 (use --all or --minimal)"; exit 2 ;;
esac

say()  { printf "\n==> %s\n" "$1"; }
ok()   { printf "    [ok] %s\n" "$1"; }
warn() { printf "    [!]  %s\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask a yes/no question, honoring --all / --minimal. Default = No.
ask() {
  [ "$MODE" = "all" ] && return 0
  [ "$MODE" = "minimal" ] && return 1
  local reply; printf "    %s [y/N] " "$1"; read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------- sanity ----------
if [ "$(uname)" != "Darwin" ]; then
  warn "This installer targets macOS. On other systems, install the deps manually (see README)."
fi

# ---------- Homebrew ----------
say "Checking Homebrew"
if have brew; then
  ok "brew found"
else
  warn "Homebrew not found. Install it from https://brew.sh first, then re-run ./setup.sh"
  exit 1
fi

# ---------- required: node + ffmpeg ----------
say "Required tools: node, ffmpeg"
if have node; then ok "node $(node -v)"; else echo "    installing node..."; brew install node; fi
if have ffmpeg; then ok "ffmpeg present"; else echo "    installing ffmpeg..."; brew install ffmpeg; fi

# ---------- node deps ----------
say "Installing Node dependencies (npm install)"
npm install
ok "node_modules ready"

# ---------- .env ----------
say "Configuring .env"
if [ -f .env ]; then
  ok ".env already exists (left untouched)"
else
  cp .env.example .env
  ok "created .env from .env.example"
fi

# ---------- Claude Code CLI ----------
say "Claude Code CLI (the brain)"
if have claude; then
  ok "claude found"
else
  if ask "Install the Claude Code CLI globally via npm?"; then
    npm install -g @anthropic-ai/claude-code || warn "global install failed — see https://docs.claude.com"
  else
    warn "skipped — install it yourself: npm install -g @anthropic-ai/claude-code"
  fi
fi

# ---------- optional: local Whisper STT ----------
say "Optional: offline speech-to-text (whisper.cpp + large-v3-turbo model, ~1.6GB)"
if ask "Install whisper-cpp and download the model now?"; then
  have whisper-server || brew install whisper-cpp
  mkdir -p "$HOME/.whisper-models"
  MODEL="$HOME/.whisper-models/ggml-large-v3-turbo.bin"
  if [ -f "$MODEL" ]; then
    ok "model already downloaded"
  else
    echo "    downloading large-v3-turbo (~1.6GB)..."
    curl -L -o "$MODEL" \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin \
      && ok "model saved to $MODEL" \
      || warn "download failed — retry later or use ElevenLabs Scribe (default)"
  fi
else
  warn "skipped — Claude Baby will use ElevenLabs Scribe for STT (needs your key)"
fi

# ---------- optional: wake word ----------
say "Optional: \"Claude\" wake word (local, no key)"
if ask "Install wake-word dependencies (portaudio + Python packages)?"; then
  have python3 || brew install python3
  brew list portaudio >/dev/null 2>&1 || brew install portaudio
  pip3 install -r requirements-wake.txt \
    && ok "wake deps installed" \
    || warn "pip install failed — see requirements-wake.txt"
  echo "    Next: run 'python3 enroll_claude.py' to record \"Claude\" 4 times,"
  echo "          then set COACH_WAKE=1 in .env."
else
  warn "skipped — you can still start a session by clicking the pet"
fi

# ---------- optional: filler audio ----------
say "Optional: pre-generated \"thinking\" filler sounds"
if grep -q '^ELEVENLABS_API_KEY=.\+' .env 2>/dev/null && ask "Generate filler audio now (uses your ElevenLabs key)?"; then
  node generate-acks.js && ok "filler audio generated" || warn "generation failed (check ELEVENLABS_API_KEY)"
else
  warn "skipped — waits will just be silent (set ELEVENLABS_API_KEY first, then: node generate-acks.js)"
fi

# ---------- optional: the pet (clawd-on-desk) ----------
say "Optional: the desktop pet (clawd-on-desk) — required to actually see/hear it"
PET_DIR="$(cd .. && pwd)/clawd-on-desk"
if [ -d "$PET_DIR" ]; then
  ok "found clawd-on-desk at $PET_DIR"
elif ask "Clone clawd-on-desk next to this folder and install it?"; then
  ( cd .. && git clone https://github.com/XiaoChu-1208/clawd-on-desk.git && cd clawd-on-desk && npm install ) \
    && ok "clawd-on-desk ready" \
    || warn "clone/install failed — set it up manually (see README)"
else
  warn "skipped — clone XiaoChu-1208/clawd-on-desk yourself before running ./start.sh"
fi

# ---------- finish ----------
cat <<'DONE'

==> Almost done. Two things only you can do:

    1) Sign in to Claude Code (uses your subscription):
         claude          # run once and log in

    2) Put your ElevenLabs API key in .env:
         ELEVENLABS_API_KEY=...     # from https://elevenlabs.io
       (and optionally set COACH_WORKDIR to the folder the agent should work in)

    Then start everything:
         ./start.sh

    See the README for usage, the wake word, and lid-closed hands-free mode.
DONE
