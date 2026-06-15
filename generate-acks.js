// generate-acks.js — 预生成 40 条"收到"反应音(同一 ElevenLabs 声音 + 同款电话音效)。
// 跑一次:  cd ~/Desktop/同步/claude-baby && node generate-acks.js
// 用户说完话送转写的那一刻,引擎随机播一条垫住等待(见 coach-engine 的 playAck)。
// 已存在的文件会跳过(可重复跑补齐)。删掉 acks/ 重跑可全部重生成。
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.ELEVENLABS_API_KEY || '';
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'OlIwv2Z2NHmIfMaCuQHJ';
const FX = process.env.COACH_VOICE_FX_COMPLEX ||
  '[0:a]highpass=f=350,lowpass=f=3400,acrusher=bits=8:samples=1:mode=log:mix=0.3,volume=2.6,alimiter=limit=0.9[out]';
const DIR = join(HERE, 'acks');

if (!KEY) { console.error('缺 ELEVENLABS_API_KEY(.env 里)'); process.exit(1); }
mkdirSync(DIR, { recursive: true });

// 40 条短确认语 —— 表达"收到了 / 想一下",自然口语,播来垫等待空档。
const PHRASES = [
  "Hmm, I see.", "Oh, let me think about it.", "Got it.", "Right...", "Mm-hmm.",
  "Okay, okay.", "Interesting.", "Let me see.", "Ah, I understand.", "Good point.",
  "Sure, sure.", "One sec.", "Let me think.", "Okay, hold on.", "I hear you.",
  "Hmm, okay.", "Alright.", "Let me process that.", "Oh, nice.", "Gotcha.",
  "Yeah, yeah.", "Hmm, interesting.", "Okay, so...", "Let me consider that.", "Right, right.",
  "Uh-huh.", "I see what you mean.", "Hmm, let me think.", "Okay then.", "Give me a moment.",
  "Ah, okay.", "That's a good question.", "Let me work on that.", "Mm, okay.", "Alright, thinking.",
  "Oh? Okay.", "Sure thing.", "Let me figure that out.", "Hmm, yes.", "Okay, got it.",
  // ── 思考/犹豫(更长,填大脑想的空档)──
  "Hmm... that's a good one. Let me think about how to put this.",
  "Okay, so... give me a second, I want to get this right.",
  "Right, right... let me turn that over for a moment.",
  "Uhh, let me see... how do I want to say this...",
  "Hmm, interesting. I'm thinking about the best way to answer.",
  "Okay, let me think... there's a couple of ways to look at this.",
  "So... hmm... let me gather my thoughts for a sec.",
  "That's actually a tricky one. Let me think it through.",
  "Mmm, okay... I'm mulling it over.",
  "Let me think... I don't want to give you a rushed answer.",
  "Hold on, let me think about that properly.",
  "Hmm, how should I put this...",
  "Okay... let me work out the best way to explain it.",
  "Give me a moment, I'm piecing it together.",
  "Hmm, let me think... yeah, okay, I'm getting there.",
  "That's a deep one. Let me sit with it for a second.",
  "Uh-huh... okay, let me think about where to start.",
  "Hmm... there's a lot to unpack there. Let me think.",
  "Okay, okay... let me organize my thoughts.",
  "Let me think for a sec... I want to give you a good answer.",
  "Hmm, good question. I'm thinking it over.",
  "So... let me see... how do I explain this clearly...",
  "Right... give me a moment to think this through.",
  "Hmm... I'm weighing a few different angles here.",
  "Okay, let me think... bear with me a second.",
  "That's interesting... let me think about it for a moment.",
  "Mmm... let me find the right words for this.",
  "Hmm, let me think... okay, I think I see where to go.",
  "Okay, so... I'm just thinking through how to say it.",
  "Let me think... yeah, there's a nice way to put this.",
  "Hmm... hold on, let me get my thoughts in order.",
  "That's a good question, actually. Let me think.",
  "Okay... let me consider that for a moment.",
  "Hmm... I want to make sure I get this right, one sec.",
  "Let me think about that... it's not totally straightforward.",
  "Uhh... okay, I'm working through it in my head.",
  "Hmm, let me think... there's something I want to say here.",
  "Okay, give me a beat... I'm thinking.",
  "So... hmm... let me think about the best example.",
  "Right, let me think this one over for a second.",
];

function fx(inMp3, outWav) {
  return new Promise((res) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inMp3, '-filter_complex', FX, '-map', '[out]', outWav]);
    ff.on('exit', (c) => res(c === 0));
    ff.on('error', () => res(false));
  });
}

let ok = 0;
for (let i = 0; i < PHRASES.length; i++) {
  const out = join(DIR, `ack_${String(i + 1).padStart(2, '0')}.wav`);
  if (existsSync(out)) { console.log('skip', out); ok++; continue; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: PHRASES[i], model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.4, similarity_boost: 0.75 } }),
  });
  if (!r.ok) { console.error('TTS 失败', i + 1, r.status); continue; }
  const mp3 = join(DIR, `_tmp_${i}.mp3`);
  writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
  const done = await fx(mp3, out);
  try { unlinkSync(mp3); } catch (_) {}
  if (done) ok++;
  console.log(done ? 'ok ' : 'fx失败 ', `${i + 1}/${PHRASES.length}`, PHRASES[i]);
}
console.log(`\n完成,${ok}/${PHRASES.length} 条在 ${DIR}`);
