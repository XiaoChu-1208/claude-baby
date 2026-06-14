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
The engine needs an ElevenLabs key for text-to-speech (and cloud STT). Ask the human for their key, then write it into `.env`:
```
ELEVENLABS_API_KEY=<the key the human gives you>
```
- Get one at https://elevenlabs.io. **Never invent, guess, or hardcode a key.**
- Optionally also set in `.env`: `COACH_WORKDIR` (the folder the agent should work in — default `~/Desktop/同步`) and `ELEVENLABS_VOICE_ID` (the TTS voice; also switchable later in Settings → Voice).
- Do not continue to step 5 until `.env` actually contains a non-empty `ELEVENLABS_API_KEY`.

## 4. (Optional) Offline speech-to-text + "Claude" wake word
Only if the human asks for them — both are optional and heavier (model download / voice enrollment). See README steps 7–8. Skip by default.

## 5. Start it
```bash
./start.sh
```
This launches the pet (`clawd-on-desk` with `CLAWD_COACH_MODE=1`) and the engine (`coach-engine.js`) in the background. Logs: `/tmp/clawd-pet.log` and `/tmp/coach-engine.log`.
Stop with: `pkill -f coach-engine.js && pkill -9 -f "clawd-on-desk/node_modules/electron"`.

## 6. Tell the human how to use it
- On first run macOS asks for **microphone permission** — click **Allow**.
- **Double-click the pet** (or shout "Claude" if the wake word was enabled) and start talking.
- To re-apply future code updates: `git pull` in both `claude-baby` and `clawd-on-desk`, then re-run `./start.sh`. There is no build step.

## Guardrails
- Never fabricate secrets (API keys, tokens).
- Never run on non-macOS.
- Confirm `.env` has the ElevenLabs key before `./start.sh`, or TTS/STT will silently fail.
