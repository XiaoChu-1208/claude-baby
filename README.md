# Claude Baby — a voice-driven desktop-pet Claude Code agent

> **Claude Baby is a hands-free, voice-controlled Claude Code agent that lives in a desktop pet.** You talk to a little pixel creature on your screen; it does real work — reads and edits files, runs shell commands, searches the web, uses your skills — and answers back in a synthesized voice. It runs on your **Claude subscription, not pay-as-you-go API credits**, by driving your already-logged-in `claude` CLI. Say "Claude" to wake it, talk to give it a task, and just start speaking to interrupt.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)

<p align="center">
  <a href="https://github.com/XiaoChu-1208/claude-baby/raw/main/assets/demo.mp4">
    <img src="https://github.com/XiaoChu-1208/claude-baby/raw/main/assets/demo.gif" width="520" alt="Claude Baby demo: talking to the desktop pet, which runs Claude Code and replies by voice">
  </a>
</p>
<p align="center"><sub>▶ Click the GIF to watch the full video with sound.</sub></p>

It is **Claude Code you can talk to**. Instead of sitting in a terminal, you keep working; the pet listens in the background, jumps out when called, does the task, and tells you when it is done — then gets out of your way.

> ### 🙏 Built on Clawd on Desk
> Claude Baby would not exist without **[Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)** by **[@rullerzhou-afk](https://github.com/rullerzhou-afk)** — the wonderful open-source desktop pet that reacts to your AI coding agent in real time. Claude Baby reuses that pet as its body and adds a voice-driven agent brain on top. Huge thanks to the original author and contributors. See [Claude Baby vs Clawd on Desk](#claude-baby-vs-clawd-on-desk) for how they differ and which to choose.

- **This repo (the "brain"):** https://github.com/XiaoChu-1208/claude-baby
- **The pet (the "body"):** original [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk); Claude Baby uses the [XiaoChu-1208/clawd-on-desk](https://github.com/XiaoChu-1208/clawd-on-desk) fork, which adds the `CLAWD_COACH_MODE` integration this brain talks to.

---

## Table of contents

1. [What is Claude Baby?](#what-is-claude-baby)
2. [Claude Baby vs Clawd on Desk](#claude-baby-vs-clawd-on-desk)
3. [Features](#features)
4. [How it works](#how-it-works)
5. [Requirements & supported conditions](#requirements--supported-conditions)
6. [Getting started (step by step)](#getting-started-step-by-step)
7. [Configuration reference (`.env`)](#configuration-reference-env)
8. [Usage](#usage)
9. [Voice pipeline (STT / TTS / wake word)](#voice-pipeline-stt--tts--wake-word)
10. [Troubleshooting](#troubleshooting)
11. [FAQ](#faq)
12. [Privacy & data](#privacy--data)
13. [License](#license)

---

## What is Claude Baby?

Claude Baby is a **voice-driven agent built on Claude Code**. A pixel pet sits on your desktop as the face; a Node.js engine (`coach-engine.js`) is the brain. When you speak, the engine transcribes your voice, sends it to a locally-running `claude` process that uses tools to get real work done, and reads the reply back to you out loud. The goal is to make Claude Code **more convenient than a terminal** — fully hands-free and always within earshot, so you can delegate a task with your voice while you keep doing something else.

It is **not** a thin chatbot over the Anthropic API. It drives the real Claude Code CLI, so it has the same tools, skills, and agentic abilities you already use — and it bills against your **Claude subscription**, not API credits.

**Good for:** quick coding and file edits, running commands, codebase questions, web research, and any "just do this for me" task you'd rather speak than type.

---

## Claude Baby vs Clawd on Desk

Claude Baby is built on **[Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)** and is meant to complement, not replace it. The key difference is **passive vs active**:

- **Clawd on Desk (the original)** is a *passive* companion. It *watches* your AI coding agent and reacts in real time — thinking, typing, celebrating, sleeping. You still drive the agent yourself by typing in a terminal/IDE. It is cross-platform (Windows, macOS, Linux), supports many agents (Claude Code, Codex, Copilot, Gemini, Cursor, and more), and ships rich pet themes.
- **Claude Baby (this project)** turns that pet into an *active, voice-first interface*. You don't type — you **speak**, and the pet *becomes* how you operate Claude Code: it listens, runs the agent, and talks back. It is macOS-only (because of the audio stack) and Claude-subscription-driven.

| | Clawd on Desk (original) | Claude Baby (this project) |
|---|---|---|
| Role | Passive status companion | Active voice interface |
| You interact by | Typing in your terminal/IDE | **Speaking** to the pet |
| Output | Animations / status | **Synthesized voice** + chat bubble |
| Drives the agent? | No — it reacts to it | **Yes** — it runs Claude Code for you |
| Agents | Claude Code, Codex, Copilot, Gemini, Cursor, … | Claude Code (via your subscription) |
| Platform | Windows · macOS · Linux | macOS only |
| Voice (STT/TTS), wake word | — | Yes |

**Which should I use?**
- Choose **Clawd on Desk** if you want a delightful, low-friction status pet while you keep coding by hand, on any OS, with any agent.
- Choose **Claude Baby** if you want to operate Claude Code **hands-free by voice** on macOS — delegate tasks out loud, get spoken answers, and call the agent without touching the keyboard.

---

## Features

- **Talk to Claude, hands-free.** Speak naturally; it listens, works, and replies by voice.
- **Real agentic work.** Full tools with auto-approval (headless `bypassPermissions`): read/edit files, run commands, search the web, and use skills inside a working directory you choose.
- **Subscription, not API credits.** It spawns your local `claude` CLI and strips `ANTHROPIC_API_KEY` from the child process, forcing subscription OAuth — no surprise API bills.
- **Barge-in: just start talking.** While it is speaking, the moment you speak it stops and gives you the turn. Interruption is triggered by your **microphone volume**, not a keyword, so it works even during long answers. Clicking the pet also interrupts.
- **Wake word "Claude" (optional).** Fully local, few-shot wake-word detection (EfficientWord-Net) — no cloud, no key. Shout "Claude" and the pet pops out.
- **Offline or cloud speech-to-text.** A local `whisper.cpp` server (free, private, no network) or ElevenLabs Scribe.
- **Natural voice output.** ElevenLabs Flash TTS, streamed, with an optional "telephone/walkie-talkie" effect.
- **Persistent, self-healing sessions.** Conversations are saved and resumable (`--resume`); if a session is lost the engine starts a fresh one and retries, and it restarts the brain on timeout instead of getting stuck.
- **Model switching on the fly.** Haiku (fast, default), Sonnet, or Opus — say "switch to opus", type `/model opus`, or POST to the control port.
- **Bilingual input.** Speech recognition auto-detects English and Chinese.

---

## How it works

```
  You (voice)
      │  microphone
      ▼
┌─────────────────────┐   spawns    ┌───────────────────────┐
│  coach-engine.js    │ ──────────▶ │  claude CLI (headless)│  ← your Claude subscription
│  (the "brain")      │ stream-json │  tools · skills · agent│
│  STT ▸ Claude ▸ TTS │ ◀────────── └───────────────────────┘
└─────────┬───────────┘
          │  HTTP POST /say  (localhost)
          ▼
┌─────────────────────┐
│   clawd-on-desk     │  the desktop pet — animations, chat bubbles
│  (the "body/face")  │  Electron app, run with CLAWD_COACH_MODE=1
└─────────────────────┘
```

1. **Listen** — the microphone is captured and transcribed (local Whisper, or ElevenLabs Scribe).
2. **Think & act** — your text goes to a long-lived `claude` process (reused across turns, context kept via `--resume`); it uses tools to do the work.
3. **Speak** — the reply is synthesized with ElevenLabs and played back; the full text also appears in the pet's chat bubble.
4. **Pet ↔ engine** — the engine drives the pet over `POST /say` (pet port from `~/.clawd/runtime.json`, default `23333`); the pet sends clicks/control to the engine's port (default `23390`).

---

## Requirements & supported conditions

**Operating system: macOS only (for now).** The audio layer uses macOS-specific tools — `ffmpeg` with `avfoundation` for the microphone, `afplay` for playback, and PortAudio for the wake word. Everything else (Node engine, Claude CLI, ElevenLabs) is cross-platform, so a Windows/Linux port mainly means swapping the audio backends. Apple Silicon and Intel both work.

You also need:

- **An active Claude subscription** (e.g. Pro or Max) with the **Claude Code CLI installed and signed in**. Without a working `claude` login the brain cannot start.
- **An ElevenLabs account + API key** — for text-to-speech, and for speech-to-text unless you set up local Whisper.
- **The clawd-on-desk pet app** — Claude Baby is the brain only; the pet is the visible body.
- **A microphone**, with permission granted to whatever runs the engine.
- **Internet** to reach Claude and ElevenLabs. Local Whisper removes the network need for transcription; restricted networks can route the engine through `HTTPS_PROXY`.

---

## Getting started (step by step)

Follow these in order. **Steps 1–6 are required; 7–9 are optional.**

### 1. Install Node.js (≥ 18.17)
```bash
brew install node        # or use nvm
node -v                  # confirm ≥ 18.17
```

### 2. Install and log in to the Claude Code CLI — the brain
```bash
npm install -g @anthropic-ai/claude-code   # see https://docs.claude.com for the latest method
claude                                      # run once, sign in to your subscription
```
Confirm `claude` works in your terminal before continuing. The engine launches it for you and forces subscription auth (it removes `ANTHROPIC_API_KEY` from the child process).

### 3. Install ffmpeg
```bash
brew install ffmpeg
```

### 4. Get the desktop pet (clawd-on-desk)
```bash
git clone https://github.com/XiaoChu-1208/clawd-on-desk.git
cd clawd-on-desk && npm install
```

### 5. Get Claude Baby and install dependencies
```bash
git clone https://github.com/XiaoChu-1208/claude-baby.git
cd claude-baby && npm install
```

### 6. Configure your ElevenLabs key
```bash
cp .env.example .env
# edit .env and set ELEVENLABS_API_KEY (get one at https://elevenlabs.io)
# also set COACH_WORKDIR to the directory you want the agent to work in
```

### 7. (Optional) Offline speech-to-text — private, free, no network
```bash
brew install whisper-cpp
mkdir -p ~/.whisper-models
# download a GGML model (e.g. ggml-large-v3-turbo.bin) into ~/.whisper-models/
```
If the model exists, the engine uses local Whisper automatically; otherwise it falls back to ElevenLabs Scribe. Force either with `COACH_STT=local` / `COACH_STT=scribe`.

### 8. (Optional) Enable the "Claude" wake word — local, no key
```bash
brew install portaudio
pip3 install -r requirements-wake.txt
python3 enroll_claude.py        # say "Claude" 4 times → generates claude_ref.json
# then set COACH_WAKE=1 in .env
```
Without it you can still operate the pet by clicking it.

### 9. (Optional) Pre-generate filler "thinking" sounds
```bash
node generate-acks.js           # uses your ElevenLabs key + ffmpeg
```
Without it, waits are simply silent.

### 10. Run it
```bash
cd claude-baby
./start.sh
```
This launches the pet (`clawd-on-desk` with `CLAWD_COACH_MODE=1`) and the engine (`coach-engine.js`) in the background. Logs go to `/tmp/clawd-pet.log` and `/tmp/coach-engine.log`.

### 11. Grant mic permission and talk
On first run macOS asks for microphone permission — click **Allow**. Then **double-click the pet** (or shout "Claude" if you enabled the wake word) and start talking.

**Stop everything:**
```bash
pkill -f coach-engine.js
pkill -9 -f "clawd-on-desk/node_modules/electron"
```

> Prefer two terminals instead of `start.sh`? Run `CLAWD_COACH_MODE=1 npm start` in `clawd-on-desk`, and `node coach-engine.js` in `claude-baby`.

---

## Configuration reference (`.env`)

Copy `.env.example` to `.env` and set what you need. Secrets and personal data never enter the repository (`.env`, your wake-word model, and generated audio are git-ignored).

| Variable | Default | What it does |
|---|---|---|
| `ELEVENLABS_API_KEY` | — | **Required.** ElevenLabs key for TTS (and Scribe STT). |
| `ELEVENLABS_VOICE_ID` | a public voice | Voice for TTS. Copy a Voice ID from your ElevenLabs Voices. |
| `COACH_WORKDIR` | `~/Desktop/同步` | Directory the agent works in (runs commands, reads/writes files). **Set this to your own project directory.** |
| `COACH_MODEL` | `haiku` | Startup model: `haiku`, `sonnet`, or `opus`. Switchable at runtime. |
| `COACH_STT` | auto | `local` (whisper.cpp) or `scribe` (ElevenLabs). Auto-detects a local model if present. |
| `COACH_WHISPER_MODEL` | `~/.whisper-models/ggml-large-v3-turbo.bin` | Path to the local Whisper model. |
| `COACH_WHISPER_LANG` | `auto` | `auto`, `en`, `zh`, … |
| `COACH_WAKE` | off | Set `1` to enable the "Claude" wake word (needs enrollment). |
| `COACH_BARGE_VOICE` | on | Set `0` to disable speak-to-interrupt (clicking still interrupts). |
| `COACH_BARGE_RMS` | `0.06` | Mic loudness to count as "you started talking". Raise if it interrupts itself on speaker echo; lower if it won't interrupt. |
| `COACH_BARGE_SUSTAIN_MS` | `110` | How long your voice must sustain before interrupting. |
| `COACH_VOICE_FX` | on | Telephone/walkie-talkie voice effect. `0` for a clean voice. |
| `MIC_DEVICE` | `:1` | macOS `avfoundation` mic (index or device name). Use the device name if indices shift. |
| `HTTPS_PROXY` | — | Outbound proxy for restricted networks. |
| `COACH_CONTROL_PORT` | `23390` | Engine control HTTP port. |

More fine-grained knobs (animation mappings, idle timeout, voice-FX filter, session directory) are documented in `.env.example` and the comments in `coach-engine.js`.

---

## Usage

- **Start a session** — double-click the pet (or shout "Claude" if the wake word is on). It pops out and starts listening.
- **Just talk** — pause for about a second and it treats you as finished, then works and replies.
- **Interrupt it** — start speaking while it talks, or click the pet. It stops immediately and the turn is yours.
- **Switch models** — say "switch to opus" / "use sonnet" / "go back to haiku", type `/model opus`, or `POST /model {"model":"opus"}` to the control port.
- **Sessions** — saved to `~/.coach-sessions/`. Hide/show the chat or restart the engine and it resumes the last conversation. The pet's right-click menu offers New / Switch / End.
- **Hide vs end** — double-clicking again just hides the chat panel (voice keeps running); use the menu's "End" to fully stop.

**Control port (for hotkeys/automation), default `127.0.0.1:23390`:**
```bash
curl -X POST 127.0.0.1:23390/model -H 'content-type: application/json' -d '{"model":"opus"}'
curl -X POST 127.0.0.1:23390/poke    # interrupt (same as clicking the pet)
```

---

## Voice pipeline (STT / TTS / wake word)

- **Speech-to-text** — local `whisper.cpp` server (offline, free, private) when a model is installed; otherwise ElevenLabs Scribe. The engine keeps a persistent whisper-server so the model loads only once.
- **Text-to-speech** — ElevenLabs Flash (`eleven_flash_v2_5`), streamed and played with `afplay`. An optional `ffmpeg` filter adds a telephone/walkie-talkie character; disable with `COACH_VOICE_FX=0`.
- **Wake word** — optional, fully local few-shot detection (EfficientWord-Net) for "Claude"; you enroll your own voice with `enroll_claude.py`. Used for waking the pet, not for interrupting (interruption is loudness-based).

**Headphones vs speakers.** Headphones are best — no acoustic echo, so listening and barge-in are flawless. On speakers, the engine filters out its own voice with a loudness gate and a transcription "hallucination" filter; tune `COACH_BARGE_RMS` if it ever interrupts itself.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Replies are always an error message | The brain hit an error — check `/tmp/coach-engine.log`. Common causes: Claude usage limit reached (switch to a cheaper model or wait for reset), a lost/too-long session (now self-heals by starting a new one), or `claude` not logged in. |
| It interrupts itself while speaking | Speaker echo crosses the loudness gate. Raise `COACH_BARGE_RMS` (e.g. `0.1`), or use headphones. |
| It won't interrupt when you talk | Lower `COACH_BARGE_RMS` (e.g. `0.04`) or `COACH_BARGE_SUSTAIN_MS`. |
| Random chat bubbles appear when silent | STT hallucinating on near-silence — already filtered; raise `COACH_MIN_VOICED_BYTES` if needed. |
| No microphone / no audio | Grant mic permission to your terminal; check `MIC_DEVICE` (use the device name, not an index). |
| ElevenLabs requests fail | Verify `ELEVENLABS_API_KEY`; set `HTTPS_PROXY` if your network blocks it. |
| The pet doesn't appear / no speech | Make sure `clawd-on-desk` is running with `CLAWD_COACH_MODE=1`; check `/tmp/clawd-pet.log`. |

---

## FAQ

### What is Claude Baby?
Claude Baby is a voice-driven desktop-pet agent built on Claude Code. A pixel pet on your desktop is the face; a Node engine (`coach-engine.js`) is the brain. You speak to it, it uses Claude Code to do real work (read/edit files, run commands, search the web, use skills), and it answers in a synthesized voice. It is a more convenient, hands-free way to use Claude Code.

### Does it use my Anthropic API credits?
No. It spawns your locally installed, logged-in `claude` CLI and removes `ANTHROPIC_API_KEY` from the child process, which forces it to use your Claude **subscription** (OAuth). Only the voice layer (ElevenLabs STT/TTS) bills against your ElevenLabs quota.

### How do I interrupt it while it's talking?
Just start speaking, or click the pet. Interruption is based on your microphone loudness, not a keyword, so it works reliably even during long answers. Tune it with `COACH_BARGE_RMS` and `COACH_BARGE_SUSTAIN_MS`.

### Does it run on Windows or Linux?
Today it targets macOS, because it captures the microphone with ffmpeg's `avfoundation`, plays audio with `afplay`, and uses PortAudio for the wake word. The Node engine, Claude CLI, and ElevenLabs are cross-platform, so a port mainly requires replacing the audio backends.

### Do I need to be online?
The brain (`claude` CLI) uses your machine's network. ElevenLabs is a cloud service; set `HTTPS_PROXY` if your network restricts it. With local `whisper.cpp`, transcription runs fully offline.

### What is the relationship to clawd-on-desk?
[clawd-on-desk](https://github.com/XiaoChu-1208/clawd-on-desk) is the open-source Electron desktop pet (AGPL-3.0) that provides the visible body and animations. Claude Baby is the brain; the two talk over local HTTP. You need both. This repository is also AGPL-3.0.

---

## Privacy & data

- API keys live only in `.env`, which is git-ignored and never committed.
- Your wake-word model (`claude_ref.json`) and raw enrollment recordings (`claude_samples/`) stay on your machine — git-ignored.
- With local Whisper (`COACH_STT=local`), speech is transcribed on-device and never leaves your computer. With ElevenLabs Scribe, audio is sent to ElevenLabs for transcription.
- Conversations are stored locally in `~/.coach-sessions/`.

---

## License

[AGPL-3.0-only](LICENSE). This project integrates with [clawd-on-desk](https://github.com/XiaoChu-1208/clawd-on-desk), which is also AGPL-3.0-only.

## Acknowledgements

- **[Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) by [@rullerzhou-afk](https://github.com/rullerzhou-afk)** — the desktop pet this project is built on. Thank you.
- [Anthropic Claude Code](https://docs.claude.com) — the agent brain.
- [ElevenLabs](https://elevenlabs.io) — speech-to-text and text-to-speech.
- [EfficientWord-Net](https://github.com/Ant-Brain/EfficientWord-Net) — local wake-word detection.
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — offline speech-to-text.
