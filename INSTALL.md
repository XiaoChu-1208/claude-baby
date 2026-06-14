# Installing Claude Baby — agent runbook

> **This file is written for an AI coding agent (the `claude` CLI) to execute top to bottom.**
> If you are a human, you don't need this — just run `./setup.sh` after cloning (see the README "Getting started").
>
> The usual way to trigger this is one command (the user already has the `claude` CLI):
>
> ```bash
> claude --dangerously-skip-permissions "Install Claude Baby on this Mac by following https://raw.githubusercontent.com/XiaoChu-1208/claude-baby/main/INSTALL.md — do every step you can, and pause to ask me only for the things I alone can provide (my ElevenLabs API key)."
> ```

You are installing **Claude Baby**, a macOS voice-driven desktop-pet built on Claude Code. A pixel pet (`clawd-on-desk`) is the body; a Node engine (`coach-engine.js`) is the brain. Work through the steps in order. Run shell commands yourself; only stop where a step is marked **HUMAN STEP**.

## 0. Preconditions — check before doing anything
- **macOS only.** Run `uname`. If it is not `Darwin`, stop and tell the human this install is macOS-only.
- **Homebrew** must exist (`command -v brew`). If missing, tell the human to install it from https://brew.sh, then continue.
- **You (`claude`) are already signed in** — so the "sign in to Claude" step is already done; do not worry about it.

## 1. Get the code
Clone the brain repo into the current directory (or a folder the human names). `setup.sh` will clone the pet itself, as a sibling, in step 3 — so do **not** clone the pet here.
```bash
git clone https://github.com/XiaoChu-1208/claude-baby.git
cd claude-baby
```
If the folder already exists, `cd` into it and `git pull` instead.

## 2. Run the installer
```bash
./setup.sh --all        # accepts every optional component (incl. ~1.6GB Whisper model + wake word + the pet)
# Use ./setup.sh --minimal instead if the human wants a slim, required-only install.
```
This installs Node + ffmpeg (via Homebrew), the Node deps, the Claude Code CLI, creates `.env` from `.env.example`, and clones `clawd-on-desk` next to this folder. It is safe to re-run. Pick `--all` or `--minimal` (never the bare interactive form — you can't answer its prompts non-interactively); ask the human which they prefer if unsure.

## 3. HUMAN STEP — ElevenLabs API key (the one thing you cannot do)
The engine needs an ElevenLabs key for text-to-speech (and cloud STT). **Never invent, guess, or hardcode a key** — get it from the human. Tell them exactly where to find it:

> **Where to get your ElevenLabs API key:**
> 1. Sign up / sign in at **https://elevenlabs.io** (the free tier is enough to start).
> 2. Click your **profile icon (bottom-left)** → **"API Keys"** — or go straight to **https://elevenlabs.io/app/settings/api-keys**.
> 3. Click **"Create API Key"**, copy the value (starts with `sk_…`).

Then write it into `.env`:
```
ELEVENLABS_API_KEY=<the sk_… key the human pasted>
```
- **Optional — pick a voice (`ELEVENLABS_VOICE_ID`):** the pet's speaking voice. Tell the human: go to **https://elevenlabs.io/app/voice-library** (or "My Voices"), open a voice, and **copy its Voice ID**. Put it in `.env` as `ELEVENLABS_VOICE_ID=...`. If skipped, a default public voice is used. (It's also switchable later in **Settings → Voice → ElevenLabs**, no restart of `.env` needed.)
- **Optional — `COACH_WORKDIR`:** the folder the agent should read/write/run commands in (default `~/Desktop/同步`). Set it to the human's own project folder.
- Do not continue to step 5 until `.env` actually contains a non-empty `ELEVENLABS_API_KEY`.

## 4. (Optional) Offline speech-to-text + "Claude" wake word
Only if the human wants them — both are optional and heavier. If they said `--all` in step 2, **`setup.sh` already did the downloads below**; otherwise tell the human where each piece comes from:

> **Offline STT model (whisper.cpp)** — so transcription is free, private, and works offline (otherwise it falls back to ElevenLabs cloud STT, which uses your key):
> - Binary: `brew install whisper-cpp`.
> - Model file (downloaded automatically by `setup.sh --all`): **`ggml-large-v3-turbo.bin`, ~1.6 GB**, from Hugging Face → **https://huggingface.co/ggerganov/whisper.cpp**, saved to `~/.whisper-models/`. Direct file: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin`.
> - Smaller option (~570 MB): `ggml-large-v3-turbo-q5_0.bin` from the same page; then point `COACH_WHISPER_MODEL` in `.env` at it.

> **"Claude" wake word** (fully on-device, no key; via [EfficientWord-Net](https://github.com/Ant-Brain/EfficientWord-Net)):
> - Deps (auto with `--all`): `brew install portaudio` + `pip3 install -r requirements-wake.txt`.
> - Then the human enrolls their own voice once: `python3 enroll_claude.py` (records "Claude" 4×), and sets `COACH_WAKE=1` in `.env`.

Skip both by default if the human didn't ask.

## 5. Start it
```bash
./start.sh
```
This launches the pet (`clawd-on-desk` with `CLAWD_COACH_MODE=1`) and the engine (`coach-engine.js`) in the background. Logs: `/tmp/clawd-pet.log` and `/tmp/coach-engine.log`.
Stop with: `pkill -f coach-engine.js && pkill -9 -f "clawd-on-desk/node_modules/electron"`.
(`setup.sh` also installs a `hello claude` / `hello stop` shell function — the human's everyday start/stop. It runs the same `start.sh`, but needs a fresh terminal to take effect, so this runbook uses `./start.sh` directly.)

## 6. Tell the human how to use it
- On first run macOS asks for **microphone permission** — click **Allow**.
- **Double-click the pet** (or shout "Claude" if the wake word was enabled) and start talking.
- From now on, start/restart with **`hello claude`** and stop with **`hello stop`** (open a new terminal first if you just installed).
- To re-apply future code updates: `git pull` in both `claude-baby` and `clawd-on-desk`, then `hello claude` again. There is no build step and no re-install (no new deps).

## Guardrails
- Never fabricate secrets (API keys, tokens).
- Never run on non-macOS.
- Confirm `.env` has the ElevenLabs key before `./start.sh`, or TTS/STT will silently fail.

## Where everything comes from (quick reference)
| Thing | Where to get it | Who does it |
|---|---|---|
| **ElevenLabs API key** (required) | https://elevenlabs.io/app/settings/api-keys (profile → API Keys) | **human** pastes into `.env` |
| ElevenLabs Voice ID (optional) | https://elevenlabs.io/app/voice-library → open a voice → copy Voice ID | human, or change later in Settings → Voice |
| Claude Code CLI (the brain) | `npm i -g @anthropic-ai/claude-code` · docs: https://docs.claude.com | `setup.sh` (and you must `claude` login once) |
| Node + ffmpeg | Homebrew (https://brew.sh) | `setup.sh` |
| Whisper STT model (optional, ~1.6 GB; ~570 MB quantized) | https://huggingface.co/ggerganov/whisper.cpp → `~/.whisper-models/` | `setup.sh --all` (auto-download) |
| "Claude" wake word (optional) | EfficientWord-Net: https://github.com/Ant-Brain/EfficientWord-Net | `setup.sh --all`, then `python3 enroll_claude.py` |
| Desktop pet (the body) | https://github.com/XiaoChu-1208/clawd-on-desk | `setup.sh` (clones as a sibling folder) |
