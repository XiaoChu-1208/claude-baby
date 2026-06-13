// 本地薄服务：托管网页 + 藏两个 key + 转发 Claude / ElevenLabs + 出站走代理。
// 一个文件就够。前端绝不接触 key，也顺手解决 CORS（同源）。

import 'dotenv/config';
import express from 'express';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 出站代理：让 Claude + ElevenLabs 的请求都走系统代理（墙内必备）----
// undici 的 global dispatcher 同时影响 Anthropic SDK（它用全局 fetch）和我们下面的 fetch。
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || '';
if (PROXY) {
  setGlobalDispatcher(new ProxyAgent(PROXY));
  console.log(`[proxy] 出站走 ${PROXY}`);
} else {
  console.log('[proxy] 未设置 HTTPS_PROXY —— 墙内大概率连不上 Claude/ElevenLabs');
}

// ---- 大脑走哪条路 ----
// claudecode（默认）：spawn 本机已登录的 `claude` CLI，吃【订阅】不吃 API credits。
// api：直连 Anthropic /v1/messages，吃【API 钱包】（需 console 充值）。
const BRAIN = (process.env.BRAIN || 'claudecode').toLowerCase();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---- key 校验 ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
console.log(`[brain] ${BRAIN === 'api' ? 'API 直连（吃 API 钱包）' : 'Claude Code 订阅（spawn ' + CLAUDE_BIN + '）'}`);
if (BRAIN === 'api' && !ANTHROPIC_API_KEY) console.warn('[warn] BRAIN=api 但缺 ANTHROPIC_API_KEY');
if (!ELEVENLABS_API_KEY) console.warn('[warn] 缺 ELEVENLABS_API_KEY（语音会失败）');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// 模型：默认 Haiku 求快；前端可切 sonnet 求质量。
const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
};

// 让 AI 先开场白的隐藏指令
const OPENER = "Let's begin. Give a short, natural opening line in character for this scenario, then ask me your first question. Reply with only that, 1–3 short sentences.";

// ============ 常驻 claude 进程：开一次、长活、自己记上下文，每轮不再冷启动 ============
let brainProc = null;   // 当前常驻进程
let brainKey = '';      // 它启动时绑定的 `${scenario}|${model}`（变了就重启）
let lineBuf = '';       // stdout 行缓冲
let pending = null;     // 正在等回复的那一轮 { resolve, reject, text, timer }

function killBrain() {
  if (brainProc) { try { brainProc.kill('SIGKILL'); } catch (_) {} }
  brainProc = null; brainKey = ''; lineBuf = '';
  if (pending) { const p = pending; pending = null; p.reject(new Error('brain restarted')); }
}

function startBrain(scenario, model) {
  killBrain();
  const args = [
    '-p',
    '--input-format', 'stream-json',   // 流式喂消息：进程不退、长活
    '--output-format', 'stream-json',
    '--verbose',
    '--safe-mode',                     // 跳过 CLAUDE.md/memory/skills，保留订阅 OAuth
    '--tools', '',                     // 关掉工具
    '--model', model === 'sonnet' ? 'sonnet' : 'haiku',
    '--system-prompt', buildSystem(scenario),
  ];
  // 关键：删掉子进程的 API key，否则 claude 优先用它（空钱包）而不走订阅
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = spawn(CLAUDE_BIN, args, { cwd: __dirname, env });
  brainProc = proc; brainKey = `${scenario}|${model}`; lineBuf = '';

  proc.stdout.on('data', (chunk) => {
    if (proc !== brainProc) return; // 旧进程的残留输出，别污染新状态
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (!pending) continue; // init / rate_limit / thinking_tokens 等噪声，忽略
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) if (b.type === 'text' && b.text) pending.text += b.text;
      } else if (ev.type === 'result') {
        const p = pending; pending = null; clearTimeout(p.timer);
        if (ev.is_error) p.reject(new Error(ev.result || ev.subtype || 'claude error'));
        else p.resolve((ev.result || p.text || '').trim());
      }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', () => {
    if (proc !== brainProc) return; // 旧进程退出，不碰当前状态
    brainProc = null; brainKey = '';
    if (pending) { const p = pending; pending = null; p.reject(new Error('brain exited')); }
  });
}

// 往常驻进程喂一句、等它这一轮答完（一次只跑一轮）
function ask(text) {
  return new Promise((resolve, reject) => {
    if (!brainProc) return reject(new Error('brain not started'));
    if (pending) return reject(new Error('brain busy'));
    pending = {
      resolve, reject, text: '',
      timer: setTimeout(() => { const p = pending; pending = null; if (p) p.reject(new Error('claude 超时')); }, 60000),
    };
    brainProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  });
}

function ensureBrain(scenario, model) {
  if (!brainProc || brainKey !== `${scenario}|${model}`) startBrain(scenario, model);
}

// ---- 系统提示：商务英语陪练。base + 场景。回复强制 1–3 句口语化。----
const BASE_SYSTEM = `You are a warm business-English speaking partner helping me prepare for a workplace English exam. Default to English. Keep every reply very short — 1 to 2 sentences, usually under 25 words — and end most turns with one short follow-up question. Brevity matters: this is fast back-and-forth speaking practice, not a monologue. Play your role naturally.

IMPORTANT — mirror my language: if I write in Chinese (which happens when I'm stuck or asking for help because my English isn't fluent yet), reply in Chinese so I'm sure to understand. Keep it short, answer what I asked, then gently invite me back to English. Never refuse to use Chinese or insist on English-only — being understood matters more than staying in English.

If I make a notable English error, model the correct phrasing naturally; at most once per turn add a line that begins exactly with "Tip:" (one short sentence). Don't nitpick. Never use markdown, lists, or emoji — this will be read aloud.`;

const SCENARIOS = {
  free: 'Scenario: free chat. Talk about my work day, plans, or anything I bring up — stay in a casual professional register.',
  alignment:
    'Scenario: aligning with a colleague. You are a teammate. We are getting on the same page about a shared piece of work — clarify ownership, surface assumptions, confirm next steps.',
  goals:
    'Scenario: quarterly goals & trade-offs. You are my manager or peer. We are deciding what to prioritise this quarter and what to drop, weighing trade-offs out loud.',
  standup:
    'Scenario: task-list stand-up. You are running a short stand-up. Ask me what I did, what I am doing, and any blockers; keep it crisp.',
  roadmap:
    'Scenario: roadmap discussion. You are a product peer. We are talking through the roadmap — sequencing, dependencies, and what ships when.',
};

function buildSystem(scenario) {
  const s = SCENARIOS[scenario] || SCENARIOS.free;
  return `${BASE_SYSTEM}\n\n${s}`;
}

// ============ 桌宠联动：把 AI 回复推给 clawd 桌宠（说话气泡 + 语义动画）============
// clawd-on-desk 跑在本机 127.0.0.1，端口写在 ~/.clawd/runtime.json（默认 23333）。
// 用 Node 原生 http 直连本地，绕开上面 setGlobalDispatcher 的代理；fire-and-forget，
// clawd 没开也不影响陪练。设 PET=0 可整体关闭联动。
const PET_ENABLED = process.env.PET !== '0';

function clawdPort() {
  if (process.env.CLAWD_PORT) return Number(process.env.CLAWD_PORT);
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.clawd', 'runtime.json'), 'utf8'));
    if (Number.isInteger(j.port)) return j.port;
  } catch (_) {}
  return 23333;
}

// 语义 → 桌宠动画状态（启发式；以后可让大脑直接吐一个 mood 标签更准）
function moodToState(text) {
  const t = (text || '').toLowerCase();
  if (/\btip:/i.test(text || '')) return 'notification';                 // 纠错/教学
  if (/(great|nice|well done|exactly|perfect|good job|excellent|awesome|that'?s right|good point|impressive|love it)\b/.test(t))
    return 'attention';                                                  // 表扬/鼓励 → 开心
  return 'juggling';                                                     // 正常对话 → 戴耳机摇摆（像在聊天）
}

// 推一条「说话+动画」给桌宠。text 为空则只切状态、不弹气泡。
function petSay({ text = '', state, theme = 'dark', ttl } = {}) {
  if (!PET_ENABLED) return;
  const payload = JSON.stringify({ text, state, theme, ttl });
  const req = http.request(
    { host: '127.0.0.1', port: clawdPort(), path: '/say', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 800 },
    (res) => { res.resume(); }   // 排空响应，别占连接
  );
  req.on('error', () => {});      // clawd 没开 / 端口不对：静默
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(join(__dirname, 'public')));

// API 直连模式的一次性调用（仅 BRAIN=api 用）
async function apiOnce(system, messages, model) {
  const resp = await anthropic.messages.create({
    model: MODELS[model] || MODELS.haiku,
    max_tokens: 200,
    system,
    messages,
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// ---- 开场：启动/重启常驻进程，让 AI 先说开场白 ----
app.post('/api/session/start', async (req, res) => {
  try {
    const { scenario = 'free', model = 'haiku' } = req.body || {};
    let text;
    if (BRAIN === 'api') {
      text = await apiOnce(buildSystem(scenario), [{ role: 'user', content: OPENER }], model);
    } else {
      startBrain(scenario, model);   // 开一次，之后整段对话都复用它
      text = await ask(OPENER);
    }
    petSay({ text, state: 'attention', theme: req.body?.theme });  // 开场白 → 桌宠开心打招呼
    res.json({ text });
  } catch (err) {
    console.error('[start]', err?.message || err);
    res.status(502).json({ error: 'start_failed', detail: String(err?.message || err) });
  }
});

// ---- 聊天：喂当前常驻进程一句（它自己记上下文）----
app.post('/api/chat', async (req, res) => {
  try {
    const { text, messages = [], scenario = 'free', model = 'haiku', theme } = req.body || {};
    petSay({ state: 'thinking' });   // 用户说完、AI 正在想 → 桌宠思考态（不弹气泡）
    let reply;
    if (BRAIN === 'api') {
      const recent = messages.slice(-16).filter((m) => m && m.role && typeof m.content === 'string');
      if (!recent.length) return res.status(400).json({ error: 'empty messages' });
      reply = await apiOnce(buildSystem(scenario), recent, model);
    } else {
      if (!text || !text.trim()) return res.status(400).json({ error: 'empty text' });
      ensureBrain(scenario, model); // 没开过/进程挂了就兜底起一个（会丢上下文，正常情况下不会触发）
      reply = await ask(text.trim());
    }
    petSay({ text: reply, state: moodToState(reply), theme });  // AI 回复 → 说话气泡 + 语义动画
    res.json({ text: reply });
  } catch (err) {
    console.error('[chat]', err?.message || err);
    res.status(502).json({ error: 'chat_failed', detail: String(err?.message || err) });
  }
});

// ---- 语音：拿文字 → ElevenLabs Flash 流式合成 → 边到边回传，前端边播 ----
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty text' });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY || '',
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5', // Flash：低延迟、0.5 字符/credit 省一半
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
    });

    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => '');
      console.error('[tts] elevenlabs', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'tts_failed', status: r.status });
    }

    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'no-store');
    // 把 web ReadableStream 接到 express 的 res，边收边发
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    console.error('[tts]', err?.message || err);
    if (!res.headersSent) res.status(502).json({ error: 'tts_failed', detail: String(err?.message || err) });
  }
});

// ---- 语音转写：浏览器录音(裸字节) → ElevenLabs Scribe → 文字（自动认中英）----
app.post('/api/stt', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty audio' });
    const ct = req.headers['content-type'] || 'audio/webm';
    const fd = new FormData();
    fd.append('model_id', 'scribe_v1');
    fd.append('file', new Blob([req.body], { type: ct }), 'audio');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY || '' }, body: fd,
    });
    if (!r.ok) {
      const d = await r.text().catch(() => '');
      console.error('[stt] scribe', r.status, d.slice(0, 200));
      return res.status(502).json({ error: 'stt_failed', status: r.status });
    }
    const j = await r.json();
    res.json({ text: (j.text || '').trim(), lang: j.language_code || '' });
  } catch (err) {
    console.error('[stt]', err?.message || err);
    if (!res.headersSent) res.status(502).json({ error: 'stt_failed', detail: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 5178;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  英语口语陪练 → ${url}\n`);
  // 自动开 Chrome（Web Speech 需要 Chrome；设 OPEN=0 可关掉）
  if (process.env.OPEN !== '0') {
    const opener = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    opener.on('error', () => { try { spawn('open', [url], { stdio: 'ignore' }); } catch (_) {} });
  }
});

// 退出时收掉常驻 claude 进程，别留孤儿
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { killBrain(); process.exit(0); });
}
