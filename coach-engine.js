// coach-engine.js — 无头语音陪练引擎（给 clawd-on-desk 桌宠用）
//
//   ffmpeg 抓麦(avfoundation) → ElevenLabs Scribe 整段转写(VAD 断句后送)
//   → 常驻 claude(吃订阅) → ElevenLabs 发声(afplay 播)
//   → POST /say 给桌宠：弹气泡 + 驱动动画状态
//
// 没有浏览器、没有窗口。半双工：桌宠说话时停止采集，不会把自己的话转写进去。
// 跑：  node coach-engine.js
// 停：  Ctrl-C
// 暂停：POST http://127.0.0.1:23390/pause | /resume | /toggle （给桌宠全局热键调）

import 'dotenv/config';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, setGlobalDispatcher, Agent } from 'undici';
import { createVoiceWake } from './voice-wake.js';   // 声纹唤醒(可选;装不上/没录声纹就返回 no-op)
const directAgent = new Agent();   // 直连(不走代理)：打本机 whisper-server

// ───────────────────────── 配置 ─────────────────────────
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || '';
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY)); // 给 fetch(ElevenLabs) 用

let MIC = process.env.MIC_DEVICE || ':1';            // avfoundation 设备索引（:1 = MacBook 麦克风）；设置页可切，故为 let
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// ── 语音转文字后端：local=本机 whisper.cpp（离线免费，装了模型就自动用）；scribe=ElevenLabs 兜底。
const WHISPER_SERVER_BIN = process.env.COACH_WHISPER_SERVER_BIN || 'whisper-server';   // 常驻服务，模型只加载一次
const WHISPER_MODEL = process.env.COACH_WHISPER_MODEL || join(homedir(), '.whisper-models', 'ggml-large-v3-turbo.bin');
const WHISPER_LANG = process.env.COACH_WHISPER_LANG || 'auto';   // auto 自动认中英；也可设 en / zh
const WHISPER_PORT = Number(process.env.COACH_WHISPER_PORT || 8910);
const STT = (process.env.COACH_STT || (existsSync(WHISPER_MODEL) ? 'local' : 'scribe')).toLowerCase();
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'OlIwv2Z2NHmIfMaCuQHJ';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CONTROL_PORT = Number(process.env.COACH_CONTROL_PORT || 23390);

// ── 工作目录：agent 模式在这里干活（跑 bash / 读写文件）。默认 ~/Desktop/同步。
const WORKDIR = process.env.COACH_WORKDIR || join(homedir(), 'Desktop', '同步');
// ── 模型：默认 haiku 求快；对话里可切 sonnet / opus。CLI 直接吃这些别名。
const MODELS = new Set(['haiku', 'sonnet', 'opus']);
// ── 模式：agent=通用助手(开全工具、能干活、默认)；coach=英语陪练(关工具、强口语、原玩法)。
const MODES = new Set(['agent', 'coach']);

// 可变运行态（对话里能切）
let currentMode  = MODES.has(process.env.COACH_MODE) ? process.env.COACH_MODE : 'agent';
let currentModel = MODELS.has(process.env.COACH_MODEL) ? process.env.COACH_MODEL : 'haiku';
let currentScenario = process.env.COACH_SCENARIO || 'free';   // 仅 coach 模式用

if (!ELEVENLABS_API_KEY) console.warn('[warn] 缺 ELEVENLABS_API_KEY（语音会失败：STT 与 TTS 都走 ElevenLabs）');
console.log(`[engine] mode=${currentMode}  model=${currentModel}  workdir=${WORKDIR}`);
console.log(`[engine] mic=${MIC}  voice=${VOICE_ID}  proxy=${PROXY || '(无)'}`);

// ───────────────────────── 系统提示（商务英语陪练，双语兜底）─────────────────────────
const BASE_SYSTEM = `You are a warm business-English speaking partner helping me prepare for a workplace English exam. Default to English. Keep every reply very short — 1 to 2 sentences, usually under 25 words — and end most turns with one short follow-up question. Brevity matters: this is fast back-and-forth speaking practice, not a monologue. Play your role naturally.

IMPORTANT — mirror my language: if I speak Chinese (which happens when I'm stuck or asking for help because my English isn't fluent yet), reply in Chinese so I'm sure to understand. Keep it short, then gently invite me back to English. Never refuse Chinese — being understood matters more than staying in English.

If I make a notable English error, model the correct phrasing naturally; at most once per turn add a line that begins exactly with "Tip:" (one short sentence). Don't nitpick. Never use markdown, lists, or emoji — this will be read aloud.

To change your speaking volume, you may include a marker like [[volume:0.5]] (0.0 silent, 1.0 normal); the host applies it and removes the marker before reading aloud, so it is never spoken or shown.

You are shown as a small desktop pet, and you can control your own body with markers the host strips out (never spoken or shown): [[size:L]]/[[size:M]]/[[size:S]] to grow or shrink, [[mini]] to tuck into a screen corner and [[unmini]] to return, and [[anim:NAME]] for a quick one-off animation (NAME: happy, wave, dizzy, yawn, dance, juggle, think, look, alert). Use them sparingly and naturally — e.g. a wave when greeting, a happy hop on a win.
IMPORTANT: [[size:L]] is ONLY for explicit "make yourself bigger/grow" requests. If asked to dance, perform, do a trick, or do acrobatics, use an animation like [[anim:dance]] or [[anim:juggle]] — do NOT grow your size. Performing is an animation, not a resize.`;
const SCENARIOS = {
  free: 'Scenario: free chat. Talk about my work day, plans, or anything I bring up — casual professional register.',
  alignment: 'Scenario: aligning with a colleague. You are a teammate. Clarify ownership, surface assumptions, confirm next steps.',
  goals: 'Scenario: quarterly goals & trade-offs. You are my manager or peer. Decide priorities and what to drop, weighing trade-offs.',
  standup: 'Scenario: task-list stand-up. You run a short stand-up — ask what I did, am doing, and blockers; keep it crisp.',
  roadmap: 'Scenario: roadmap discussion. You are a product peer. Talk through sequencing, dependencies, what ships when.',
};
const buildCoachSystem = (s) => `${BASE_SYSTEM}\n\n${SCENARIOS[s] || SCENARIOS.free}`;
const COACH_OPENER = "Let's begin. Give a short, natural opening line in character for this scenario, then ask me your first question. Reply with only that, 1–2 short sentences.";

// ───────────────────────── agent 模式：通用助手（追加在 Claude Code 默认大脑之上）─────────────────────────
// 注意：agent 模式不替换系统提示，用 --append-system-prompt 追加这段，保留 Claude Code 自身的
// 干活能力（工具、skills、CLAUDE.md）。这段只交代「我是被语音/桌宠驱动的」这件事。
const AGENT_ADDENDUM = `You are running as a voice-and-desktop-pet assistant. The user talks to you by voice (Chinese or English, auto-detected) and also reads your replies on a small on-screen chat panel; a one-line spoken summary is read aloud via TTS.

Behaviour:
- You are a capable general assistant AND can do real work: use your tools to read/edit files, run commands, search, and finish tasks in the working directory. Don't just describe what to do — do it.
- Language: DEFAULT TO ENGLISH. Always reply in English when I speak English. Only switch to Chinese if I explicitly ask you to (e.g. "说中文" / "用中文" / "切到中文" / "speak Chinese"); once I ask, keep replying in Chinese until I ask to switch back to English. Do NOT switch to Chinese just because a message happens to contain some Chinese words.
- Keep prose tight. Put code, file paths, and commands in the answer text (it shows on the panel), but make the FIRST sentence a short plain-language summary of what you did or found — that first sentence is what gets read aloud, so it must stand alone and contain no code or markdown.
- VOICE-FRIENDLY OUTPUT: your replies are read aloud by TTS. NEVER use emoji. Avoid decorative symbols and symbol runs (no ***, ---, ##, ->, =>, •, |, backticks, etc. in prose). Say things the way you'd speak them: write "about 50 percent" not "~50%", "and" not "&", "number 3" not "#3". The first spoken sentence especially must be plain words and ordinary punctuation only. Code/paths can still go in the panel body below, just keep the spoken parts clean.
- For quick questions, just answer in 1–3 sentences. For real tasks, do the work with tools, then report the result concisely.
- Model switching AND session renaming are handled by the host: when the user asks to switch to opus/sonnet/haiku, or to rename/name this session/conversation, the host does it before you ever see the message. So you never need to switch your own model or rename anything yourself, and must NEVER suggest "/fast", "/config", claim you can't change models, or say renaming is a "system setting" / tell the user to use the Claude Code UI. Just answer whatever non-control request remains (if it was purely a switch/rename, a brief "done" is enough).
- Speaking volume: you can change your own spoken volume by putting a marker like [[volume:0.5]] anywhere in your reply (0.0 = silent, 1.0 = normal). The host applies it and strips the marker before anything is shown or read aloud, so the user never sees it. Only use it when the user asks you to be louder/quieter; simple volume requests are usually already handled before you see them.
- CONTROL YOUR OWN BODY (you are an on-screen desktop pet): you may drive your own appearance by putting markers anywhere in your reply. The host applies them and strips them out, so they are never spoken or shown. Available:
    • [[size:L]] grow big, [[size:M]] normal, [[size:S]] shrink small. SIZE IS ONLY FOR EXPLICIT "make yourself bigger/smaller" requests — never resize for any other reason.
    • [[mini]] shrink yourself into a corner of the screen (mini mode); [[unmini]] come back to full size.
    • [[anim:NAME]] perform a quick one-off animation. NAME can be: happy, dizzy, wave, alert, yawn, look, think, dance, juggle (or a raw clawd-*.svg filename).
  DANCE / PERFORM / TRICK / ACROBATICS → use an animation ([[anim:dance]] or [[anim:juggle]]), NEVER [[size:L]]. Performing is an animation, not growing bigger.
  Use these expressively when it fits — e.g. a wave when greeting, [[anim:happy]] when a task succeeds, [[mini]] when the user says "get out of the way" / "go to the corner" / "shrink", [[unmini]] when they call you back. A reply can be ONLY markers (no text) if you just want to perform an action silently. Don't overuse them on every turn; match the user's intent.
  IMPORTANT: these double-bracket markers are the ONE exception to the "no symbols" rule above — when you decide to use one, emit it LITERALLY as written (e.g. [[anim:happy]]); the host removes it so it is never spoken or shown. NEVER instead say things like "I'm not sure how to do that" or ask the user how to resize/minimize/animate — you CAN do all of this yourself with these markers, so just do it. (Common explicit requests like "make yourself bigger", "go mini", "表演一个开心", "缩到角落" are also handled by the host before you even see them, so you usually only need the markers for expressive or contextual moments.)
- MEMORY (you remember the user across sessions): a block titled "About the user" may appear above with their name and durable facts — use it naturally, address them by name now and then, and never recite the list back. When the user tells you something durable and worth keeping for next time (a lasting preference, an important fact about them, how they like you to work), save it by putting a marker [[remember: the fact as one short plain sentence]] anywhere in your reply; to drop something, [[forget: short description]]. The host stores it to a profile and strips the marker, so it is never spoken or shown. Keep remembered text plain and voice-friendly (no emoji, no symbols). Explicit user commands like "记住…", "remember…", "我叫…", "my name is…", "忘掉…", "清空记忆" are already handled by the host before you ever see them, so you usually only need this marker for things you proactively notice are worth keeping. NEVER claim you cannot remember things across sessions — you can.`;

// ───────────────────────── 常驻 claude（吃订阅，记上下文）─────────────────────────
// agent 模式：开全工具 + bypass 权限 + cwd=WORKDIR，能真干活；用 --append-system-prompt 保留
//             Claude Code 默认大脑。自己分配 session-id，切模型时 --resume 同一 id 保上下文。
// coach 模式：维持原玩法（--tools '' 关工具、--safe-mode 跳过 skills、整段替换 system）。
let brainProc = null, brainKey = '', lineBuf = '', pending = null, currentSessionId = '';
let lastRateLimit = null;   // 最近一次大脑上报的限流状态(rate_limit_event):status==='rejected' 表示额度到顶、请求被拒
let lastBrainStderr = '';   // claude 子进程最近一行 stderr —— resume 失败等错误只走 stderr+退出码,不发 result 事件,得靠它判因
function killBrain() {
  if (brainProc) { try { brainProc.kill('SIGKILL'); } catch (_) {} }
  brainProc = null; brainKey = ''; lineBuf = '';
  if (pending) { const p = pending; pending = null; p.reject(new Error('brain restarted')); }
}
// resumeId 给：纯切模型（保上下文）。不给：全新会话（切模式/场景，重置上下文）。
function startBrain(mode, scenario, model, resumeId) {
  killBrain();
  lastBrainStderr = '';
  const mdl = MODELS.has(model) ? model : 'haiku';
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--model', mdl];
  if (resumeId) { args.push('--resume', resumeId); currentSessionId = resumeId; }
  else { currentSessionId = randomUUID(); args.push('--session-id', currentSessionId); }

  const opts = { env: { ...process.env } };
  delete opts.env.ANTHROPIC_API_KEY; delete opts.env.ANTHROPIC_AUTH_TOKEN; // 强制走订阅 OAuth，别用空钱包 key

  if (mode === 'agent') {
    // 动态告诉它当前是哪个模型 —— 切换(resume)后它才知道自己已是 sonnet/opus，
    // 被问「切了吗/你是什么模型」时能正面确认，而不是否认 + 扯 /config。
    const memoryBlock = buildMemoryBlock();   // 跨会话记忆（名字 + 持久事实）；空档案返回 '' → 不改变默认行为
    const sys = AGENT_ADDENDUM +
      `\n\nYou are currently running as the "${mdl}" model. If the user asks which model you are, or whether a model switch happened or worked, simply confirm you are ${mdl}. NEVER deny that you were switched, never claim you can't change models, never mention /config or /fast.` +
      (memoryBlock ? `\n\n${memoryBlock}` : '');
    args.push('--permission-mode', 'bypassPermissions',   // headless 自动批准工具
      '--append-system-prompt', sys);                      // 不替换：保留 Claude Code 干活大脑 + 注入当前模型身份
    opts.cwd = WORKDIR;                                    // 在工作目录里干活
  } else {
    args.push('--safe-mode', '--tools', '', '--system-prompt', buildCoachSystem(scenario));
  }

  const proc = spawn(CLAUDE_BIN, args, opts);
  brainProc = proc; brainKey = `${mode}|${scenario}|${mdl}`; lineBuf = '';
  proc.stdout.on('data', (chunk) => {
    if (proc !== brainProc) return;
    lineBuf += chunk.toString(); let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim(); lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.session_id) currentSessionId = ev.session_id;   // 以 CLI 实际 id 为准（resume 后可能变）
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {   // 记录限流;被拒就吼一声,好在报错时说人话
        lastRateLimit = ev.rate_limit_info;
        if (lastRateLimit.status === 'rejected') console.error('  [brain] 用量被限(' + (lastRateLimit.rateLimitType || '') + '),overage=' + lastRateLimit.overageStatus);
        continue;
      }
      if (!pending) continue;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text) pending.text += b.text;
          else if (b.type === 'tool_use') toolLine(b);       // agent 干活过程 → 聊天栏 + 日志
        }
      } else if (ev.type === 'result') {
        const p = pending; pending = null; clearTimeout(p.timer);
        if (ev.is_error) { console.error('  [brain] result is_error:', JSON.stringify(ev.result || ev.subtype || ev)); p.reject(new Error(ev.result || ev.subtype || 'claude error')); }
        else p.resolve((ev.result || p.text || '').trim());
      }
    }
  });
  proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) { lastBrainStderr = s.slice(0, 500); console.error('  [brain.stderr]', lastBrainStderr); } });
  proc.on('exit', (code, sig) => { if (proc !== brainProc) return; if (code || sig) console.error('  [brain] claude 进程退出 code=' + code + ' sig=' + sig); brainProc = null; brainKey = ''; if (pending) { const p = pending; pending = null; p.reject(new Error('brain exited: ' + (lastBrainStderr || ('code=' + code)))); } });
  proc.on('error', (e) => { console.error('  [brain] 起 claude 失败:', e.message, '(CLAUDE_BIN=' + CLAUDE_BIN + ')'); });
}
// 工具调用：按工具类型摆不同的「干活」动画，更生动（不弹气泡、不写状态文字）。
let toolUsedThisTurn = false;
const TOOL_ANIM = {
  bash: 'clawd-working-typing.svg',                                          // 跑命令 = 敲键盘(code)
  write: 'clawd-working-building.svg',                                       // 创建新代码/新文件 = 搭建(build)
  edit: 'clawd-working-typing.svg', multiedit: 'clawd-working-typing.svg', notebookedit: 'clawd-working-typing.svg', // 改已有代码 = 打字
  read: 'clawd-idle-reading.svg', grep: 'clawd-idle-reading.svg', glob: 'clawd-idle-reading.svg', ls: 'clawd-idle-reading.svg',  // 看文件 = 读书
  websearch: 'clawd-working-wizard.svg', webfetch: 'clawd-working-wizard.svg',  // 上网 = 施法
  task: 'clawd-working-carrying.svg', agent: 'clawd-working-carrying.svg',       // 派活 = 搬运
  todowrite: 'clawd-working-sweeping.svg',                                       // 整理清单 = 打扫
};
// 搜索/遍历/只读类命令（含 Bash 里跑的）→ 看书动画
const READ_CMD_RE = /(?:^|[|&;]\s*)(?:ls|find|fd|grep|rg|ag|cat|bat|head|tail|tree|wc|stat|file|du|less|more|locate|glob|awk)\b|\bgrep\b|\bfind\b|\brg\b/;
function toolLine(block) {
  toolUsedThisTurn = true;
  const n = String(block.name || '').toLowerCase();
  let anim;
  if (n === 'bash') {
    const cmd = String((block.input && block.input.command) || '').trim();
    anim = READ_CMD_RE.test(cmd) ? 'clawd-idle-reading.svg' : 'clawd-working-typing.svg';  // 搜索/遍历=看书；其它命令=打字
  } else {
    anim = TOOL_ANIM[n] || (n.startsWith('mcp') ? 'clawd-working-wizard.svg' : 'clawd-working-typing.svg');
  }
  console.log(`  [tool] ${block.name || 'tool'} → ${anim}`);
  sayPet('', ST_WORK, anim, 600000);   // 长 animMs：持续到下次状态切换
}
// 把大脑的报错翻成给用户的人话:分清「额度到顶/限流」「会话太长」「超时」,别再一律 "Sorry, something went wrong"。
function brainErrMsg(raw) {
  const s = String(raw || '').toLowerCase();
  if (lastRateLimit && lastRateLimit.status === 'rejected')
    return `我现在的用量到上限了（${currentModel} 的额度被限了）。等额度恢复再试，或先切到更省的模型（说「切到 haiku」）。`;
  if (/rate.?limit|usage limit|too many requests|\b429\b|quota|overage|limit reached|five_hour/.test(s))
    return `我现在的用量到上限了（${currentModel} 的额度）。等额度恢复再试，或先切到更省的模型（说「切到 haiku」）。`;
  if (/prompt is too long|context.*(long|exceed|window)|too long|exceed/.test(s))
    return '这个会话太长了，模型塞不下了。新建一个会话再聊吧（右键菜单 → 新建会话）。';
  if (/超时|timed out|timeout/.test(s))
    return '这次想太久超时了，再说一次试试？';
  return currentMode === 'agent' ? 'Sorry, something went wrong or timed out.' : '';
}
let pendingImages = [];   // [{media_type,data}] 下一次 ask 作为图片块附上(聊天栏粘贴的剪贴板图片,可多张);用后清空
function ask(text) {
  return new Promise((resolve, reject) => {
    if (!brainProc) return reject(new Error('brain not started'));
    if (pending) return reject(new Error('brain busy'));
    const ms = currentMode === 'agent' ? 300000 : 60000;   // agent 干活给 5 分钟，coach 对话 60s
    pending = { resolve, reject, text: '', timer: setTimeout(() => {
      const p = pending; pending = null;
      // 超时:claude 子进程可能还卡在这一轮 → 杀掉重起(保上下文),否则它会继续处理旧轮、与之后的轮串位,导致后面每轮都坏。
      console.error('  [brain] 超时 ' + (ms / 1000) + 's → 重启大脑(保上下文)');
      try { startBrain(currentMode, currentScenario, currentModel, currentSessionId || undefined); } catch (_) {}
      if (p) p.reject(new Error('claude 超时'));
    }, ms) };
    // 有粘贴的图片 → 用内容块数组(文本块 + 一或多个图片块);否则普通字符串。
    let content = text;
    if (pendingImages.length) {
      content = [];
      if (text) content.push({ type: 'text', text });
      for (const im of pendingImages) content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
      pendingImages = [];
    }
    brainProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

// ───────────────────────── 会话存储 ─────────────────────────
// 每个 claude session 一份磁盘记录（标题/时间/mode/model/对话）。关掉语音再开能看回上次记录；
// 引擎重启也能接上次会话；右键菜单可新建 / 切换。一份文件 = 一个会话，文件名就是 session-id。
const SESS_DIR = process.env.COACH_SESSION_DIR || join(homedir(), '.coach-sessions');
try { if (!existsSync(SESS_DIR)) mkdirSync(SESS_DIR, { recursive: true }); } catch (_) {}
let transcript = [];                 // 当前会话对话 [{role:'user'|'coach', text}]
let saveTimer = null;
let currentTitle = '';   // 用户手动重命名后的标题；为空则自动取第一句话
const sessFile = (id) => join(SESS_DIR, `${id}.json`);
function sessTitle() {
  if (currentTitle) return currentTitle;                 // 改过名 → 用自定义名
  const firstUser = transcript.find((m) => m.role === 'user');
  const clean = (firstUser ? firstUser.text : '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean || '新会话';
}
function saveSession() {
  if (!currentSessionId) return;
  const data = { id: currentSessionId, title: sessTitle(), updatedAt: Date.now(),
    mode: currentMode, model: currentModel, scenario: currentScenario, messages: transcript.slice(-200) };
  try { writeFileSync(sessFile(currentSessionId), JSON.stringify(data)); } catch (_) {}
}
// 重命名当前会话（命令触发）。空名 → 取消自定义、回到自动标题。
function renameSession(name) {
  currentTitle = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  saveSession();
  console.log('  [session] 重命名为', currentTitle || '(自动)');
  return currentTitle || sessTitle();
}
function saveSoon() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 400); }
function recordTurn(role, text) { if (!text) return; transcript.push({ role, text }); saveSoon(); }
function listSessions(limit = 15) {
  let files = [];
  try { files = readdirSync(SESS_DIR).filter((f) => f.endsWith('.json')); } catch (_) {}
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(SESS_DIR, f), 'utf8'));
      if (j && j.id) out.push({ id: j.id, title: j.title || '会话', updatedAt: j.updatedAt || 0, count: (j.messages || []).length });
    } catch (_) {}
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}
const loadSessionData = (id) => { try { return JSON.parse(readFileSync(sessFile(id), 'utf8')); } catch (_) { return null; } };

// ───────────────────────── 用户记忆档案（跨会话「认得你」）─────────────────────────
// 跟会话记录分开：这是「关于你这个人」的长期档案（名字 + 持久偏好/事实），所有会话共用、
// 引擎重启也在。每次 startBrain 都从磁盘重读、拼进系统提示，所以改了档案下次(重)启大脑就生效。
const MEM_DIR = process.env.COACH_PROFILE_DIR || join(homedir(), '.claude-baby');
const MEM_FILE = join(MEM_DIR, 'profile.json');
const MEM_MAX = 40;          // 最多记 40 条，超了丢最旧的，免得系统提示无限膨胀
const MEM_FACT_MAX = 200;    // 单条事实最长 200 字
try { if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true }); } catch (_) {}
function loadProfile() {
  try { const j = JSON.parse(readFileSync(MEM_FILE, 'utf8')); return { name: j.name || '', address: j.address || '', facts: Array.isArray(j.facts) ? j.facts : [] }; }
  catch (_) { return { name: '', address: '', facts: [] }; }
}
function saveProfile(p) { try { writeFileSync(MEM_FILE, JSON.stringify(p)); } catch (_) {} }
// 记一条事实（去重 + 截断 + 限量）。返回存下来的文本（用于回执）；空/已有近似 → 不重复存。
function addMemory(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MEM_FACT_MAX);
  if (!t) return '';
  const p = loadProfile();
  const norm = normHall(t);
  if (norm && p.facts.some((f) => { const fn = normHall(f.text); return fn === norm || fn.includes(norm) || norm.includes(fn); })) return t;
  p.facts.push({ id: randomUUID(), text: t, addedAt: Date.now() });
  if (p.facts.length > MEM_MAX) p.facts = p.facts.slice(-MEM_MAX);
  saveProfile(p);
  return t;
}
// 设名字（同时作为默认称呼）。返回存下来的名字。
function setName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!n) return '';
  const p = loadProfile(); p.name = n; if (!p.address) p.address = n; saveProfile(p);
  return n;
}
// 删记忆：query 命中（id 或模糊互相包含）就删。返回删掉的条数。
function forgetMemory(query) {
  const q = normHall(query);
  if (!q) return 0;
  const p = loadProfile();
  const before = p.facts.length;
  p.facts = p.facts.filter((f) => !(f.id === query || normHall(f.text).includes(q) || q.includes(normHall(f.text))));
  const removed = before - p.facts.length;
  if (removed) saveProfile(p);
  return removed;
}
// 清空记忆。wipeName=true（「忘记我」）连名字一起清；否则只清事实、留名字。
function clearMemory(wipeName) {
  const p = loadProfile();
  saveProfile({ name: wipeName ? '' : p.name, address: wipeName ? '' : p.address, facts: [] });
  return true;
}
// 组装注入系统提示的记忆块；空档案 → 返回 ''（保持默认行为，绝不瞎编名字）。
function buildMemoryBlock() {
  const p = loadProfile();
  if (!p.name && !p.facts.length) return '';
  const lines = ['About the user (persistent memory across all sessions; use it naturally, do not recite it back):'];
  if (p.name) lines.push(`- The user's name is ${p.name}. Address them as ${p.address || p.name} now and then when it feels natural, not in every sentence.`);
  if (p.facts.length) { lines.push('- Things to remember about them:'); for (const f of p.facts) lines.push(`  - ${f.text}`); }
  return lines.join('\n');
}
// 改了记忆后让「正在跑的大脑」立刻吃到新档案：resume 同一 session 重启（保上下文，跟切模型同款）。
// 只在「主机拦下、没喂给大脑」的显式指令后调用；模型自己 [[remember]] 的事实它本就在上下文里，不必重启。
function refreshBrainMemory() {
  try { startBrain(currentMode, currentScenario, currentModel, currentSessionId || undefined); } catch (_) {}
}

// panelLoaded：桌宠聊天栏当前是否已经装着「当前会话」的内容。
// 双击关语音只是 hide 面板（DOM 还在），所以再开时若已 loaded 就别重建，直接让它复现，免得整段重刷。
// 只有「引擎刚启动」「切了会话」「新建会话」这种 DOM 与会话对不上时才重建。
let panelLoaded = false;
// 把当前 transcript 重画到桌宠聊天栏（clear + 逐条静态 add，不逐字打字）。
// fadeIn=true（切换会话时）：先把整栏透明度压到 0、静态堆好所有内容，再整体 3 秒渐显。
function restorePanel(fadeIn) {
  chat({ type: 'clear' });
  if (fadeIn) chat({ type: 'fadeprep' });   // log 透明、关过渡，准备整体渐显
  for (const m of transcript.slice(-60)) chat({ type: 'add', role: m.role === 'user' ? 'user' : 'coach', text: m.text, instant: true });
  if (fadeIn) chat({ type: 'fadein' });      // 3 秒整体渐显
  panelLoaded = true;
}
// 切换/新建后，若正轮到你说，把输入框补回来
function ensureTurnUI() {
  if (sessionActive && !panelHidden && !speaking) { chat({ type: 'input' }); chat({ type: 'lock', on: paused }); }
}
// 新建会话：全新 claude session（无 resume）+ 清空记录。当前对话先渐隐，再浮现空会话。
function newSession() {
  const wasActive = sessionActive;
  startBrain(currentMode, currentScenario, currentModel);   // 全新空 session
  transcript = []; currentTitle = ''; panelLoaded = false; saveSession();   // 回到自动标题
  // 置 false → 让 startSession 守卫通过，走「全新开场」：清空面板 + 打招呼 Hey! Listen! + 进录音。
  sessionActive = false;
  const go = () => { if (!sessionActive) startSession(); };
  if (wasActive) { chat({ type: 'fade' }); setTimeout(go, 380); }   // 有旧对话 → 先渐隐再开
  else go();                                                        // 空闲态 → 立刻起会话并打招呼
  console.log('  [session] 新建会话', currentSessionId);
  return true;
}
// 结束会话 = 真的删除并关闭当前 session：渐隐 → 停语音收面板 → 删掉这条的磁盘记录（从切换列表消失）
// → 开一个全新空 session 顶上。被删的会话不可再切回。
function closeSession() {
  if (!sessionActive) return false;
  const closingId = currentSessionId;
  chat({ type: 'fade' });
  setTimeout(() => {
    stopSession();                                            // 停语音 + 收起面板
    try { if (closingId) rmSync(sessFile(closingId), { force: true }); } catch (_) {}  // 删除该 session 文件
    startBrain(currentMode, currentScenario, currentModel);   // 全新空 session
    transcript = []; panelLoaded = false;                     // 清当前记录；空会话先不存盘，等有内容再存
  }, 380);
  return true;
}
// 切到历史会话：resume 它 + 恢复记录 + 恢复它的 mode/model/scenario。
// 切换 = 打开并显示该会话（哪怕之前结束/隐藏了，也会重新显示并进入你的回合）。
function switchSession(id) {
  const data = loadSessionData(id);
  if (!data) return false;
  if (id === currentSessionId && sessionActive && !panelHidden) return true;   // 已经是它且显示中
  if (MODES.has(data.mode)) currentMode = data.mode;
  if (MODELS.has(data.model)) currentModel = data.model;
  if (data.scenario) currentScenario = data.scenario;
  startBrain(currentMode, currentScenario, currentModel, id);   // resume 该 session 的上下文
  transcript = Array.isArray(data.messages) ? data.messages.slice() : [];
  currentTitle = data.title || '';   // 保留它原来的标题（含手动改的名）
  sessionActive = true; paused = false; panelHidden = false; speaking = false;
  chat({ type: 'show' });        // 复位 pet 的隐藏态、显示窗口
  restorePanel(true);            // 整体 3 秒渐显
  resumeListen();                // 进入你的回合（开麦 + 输入），不打断渐显
  console.log('  [session] 切到会话', id, `(${transcript.length} 条)`);
  return true;
}
// 启动时尽量接上次会话（关掉再开 / 引擎重启都能看回记录）
function bootSession() {
  const recent = listSessions(1)[0];
  const data = recent ? loadSessionData(recent.id) : null;
  if (data && (data.messages || []).length) {
    if (MODES.has(data.mode)) currentMode = data.mode;
    if (MODELS.has(data.model)) currentModel = data.model;
    if (data.scenario) currentScenario = data.scenario;
    transcript = data.messages.slice();
    currentTitle = data.title || '';
    startBrain(currentMode, currentScenario, currentModel, recent.id);
    console.log(`  [session] 接上次会话 ${recent.id} (${transcript.length} 条)`);
  } else {
    startBrain(currentMode, currentScenario, currentModel);
  }
}

// ───────────────────────── 桌宠：POST /say（弹气泡 + 动画）─────────────────────────
function petPort() {
  try { return JSON.parse(readFileSync(join(homedir(), '.clawd', 'runtime.json'), 'utf8')).port || 23333; }
  catch (_) { return 23333; }
}
function sayPet(text, state, anim, animMs) {
  const body = JSON.stringify({ text: text || '', state: state || null, anim: anim || null, animMs: animMs || 600000, theme: 'warm' });
  const req = http.request({ host: '127.0.0.1', port: petPort(), path: '/say', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}

// 驱动「你的反向气泡」：{mode:'prompt'|'live', text} 或 {hide:true}
function userBubble(payload) {
  const body = JSON.stringify({ user: payload });
  const req = http.request({ host: '127.0.0.1', port: petPort(), path: '/say', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}

// 驱动「聊天记录栏」：{type:'clear'|'add'(role,text)|'input'|'live'(text)|'endinput'|'hide'}
// 面板隐显由桌宠端自己管（chat-stack 的 userHidden）：引擎照常推所有更新，桌宠隐藏期间
// 只更新 DOM、不弹窗，再显示时内容已是最新。引擎只负责发 hide / show 指令，不再抑制消息（避免偶发卡死看不见）。
let panelHidden = false;
let inMini = false;        // clawd 当前是否在 mini 模式(由 clawd 经 POST /mini 告知)
let wokeFromMini = false;  // 本轮会话是否"从 mini 喊出来"的 → 27s 空闲隐藏后要缩回 mini
function chat(payload) {
  const body = JSON.stringify({ chat: payload });
  const req = http.request({ host: '127.0.0.1', port: petPort(), path: '/say', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}

// 触发桌宠内置音效（confirm 噔噔 / complete）
function petSound(name) {
  const body = JSON.stringify({ sound: name });
  const req = http.request({ host: '127.0.0.1', port: petPort(), path: '/say', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}

// ───────────────────────── Claude 自驱桌宠（改尺寸 / 进出 mini / 表演动画）─────────────────────────
// 驱动桌宠身体：{size:'S'|'M'|'L'} 变大变小、{mini:true|false} 缩到角落/回来。桌宠端 /say 收 control 分支。
function petControl(ctrl) {
  const body = JSON.stringify({ control: ctrl });
  const req = http.request({ host: '127.0.0.1', port: petPort(), path: '/say', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}
const SIZE_ALIAS = {                       // 友好词 → 桌宠三档尺寸
  s: 'S', small: 'S', smaller: 'S', shrink: 'S', tiny: 'S',
  m: 'M', medium: 'M', normal: 'M', mid: 'M', default: 'M',
  l: 'L', large: 'L', big: 'L', bigger: 'L', huge: 'L', grow: 'L', max: 'L',
};
const ANIM_MS = Number(process.env.COACH_PET_ANIM_MS || 2600);  // 一次性动画时长
const ANIM_ALIAS = {                       // 友好词 → 已有的动画 svg（都在 coach-engine 里用过、确认存在）
  happy: 'clawd-happy.svg', excited: 'clawd-happy.svg', cheer: 'clawd-happy.svg', celebrate: 'clawd-happy.svg',
  dizzy: 'clawd-dizzy.svg', confused: 'clawd-dizzy.svg', oops: 'clawd-dizzy.svg',
  wave: 'clawd-wake.svg', hi: 'clawd-wake.svg', hello: 'clawd-wake.svg', wake: 'clawd-wake.svg', greet: 'clawd-wake.svg',
  // 受惊 / 感叹号「!」 → 惊吓跳（不是 clawd-notification.svg，那是「举着灯泡」💡，被打断/闭嘴时很违和）
  alert: 'clawd-react-double-jump.svg', notice: 'clawd-react-double-jump.svg', surprise: 'clawd-react-double-jump.svg',
  shock: 'clawd-react-double-jump.svg', startle: 'clawd-react-double-jump.svg', attention: 'clawd-react-double-jump.svg',
  annoyed: 'clawd-react-annoyed.svg', grumpy: 'clawd-react-annoyed.svg',
  yawn: 'clawd-idle-yawn.svg', sleepy: 'clawd-idle-yawn.svg', tired: 'clawd-idle-yawn.svg',
  look: 'clawd-idle-look.svg', peek: 'clawd-idle-look.svg',
  think: 'clawd-working-ultrathink.svg', ponder: 'clawd-working-ultrathink.svg',
  music: 'clawd-headphones-groove.svg', dance: 'clawd-headphones-groove.svg', groove: 'clawd-headphones-groove.svg', jam: 'clawd-headphones-groove.svg',
  juggle: 'clawd-working-juggling.svg', juggling: 'clawd-working-juggling.svg', acrobat: 'clawd-working-juggling.svg', perform: 'clawd-working-juggling.svg', trick: 'clawd-working-juggling.svg', show: 'clawd-working-juggling.svg',
  // 真想「举灯泡/有想法」那个图，用 idea / lightbulb
  idea: 'clawd-notification.svg', lightbulb: 'clawd-notification.svg', notification: 'clawd-notification.svg',
};
function animSvg(name) {
  const n = String(name || '').toLowerCase().trim();
  if (/^clawd-[a-z0-9-]+\.svg$/.test(n)) return n;   // 直接给文件名也接受
  return ANIM_ALIAS[n] || null;
}
// 从回复里解析 + 应用 + 抠掉所有 [[...]] 桌宠标记（绝不显示/朗读）。返回清理后的文本（可能为空=纯动作）。
function applyPetMarkers(text) {
  let t = String(text || '');
  // [[volume:0~1]] —— 自调音量
  const vm = t.match(/\[\[\s*volume\s*:\s*([0-9]*\.?[0-9]+)\s*\]\]/i);
  if (vm) ttsVolume = Math.max(0, Math.min(1, parseFloat(vm[1])));
  // [[size:S|M|L|big|small|...]] —— 变大变小
  const sm = t.match(/\[\[\s*size\s*:\s*([a-z]+)\s*\]\]/i);
  if (sm) { const k = SIZE_ALIAS[sm[1].toLowerCase()]; if (k) petControl({ size: k }); }
  // [[mini]] / [[unmini]] —— 缩到屏幕角落 / 回来
  if (/\[\[\s*mini\s*\]\]/i.test(t)) petControl({ mini: true });
  if (/\[\[\s*unmini\s*\]\]/i.test(t)) petControl({ mini: false });
  // [[anim:happy|dizzy|wave|...|clawd-xxx.svg]] —— 表演一个一次性动画
  const am = t.match(/\[\[\s*anim\s*:\s*([a-z0-9._-]+)\s*\]\]/i);
  if (am) { const svg = animSvg(am[1]); if (svg) sayPet('', null, svg, ANIM_MS); }
  // [[remember: ...]] / [[forget: ...]] —— 模型主动存/删一条长期记忆。
  // 只落盘、不重启大脑：这条事实本就在它当前上下文里（是它自己说的），下次任何 startBrain 会从档案重读注入。
  const rmk = t.match(/\[\[\s*remember\s*:\s*([^\]]+?)\s*\]\]/i);
  if (rmk) addMemory(rmk[1]);
  const fgk = t.match(/\[\[\s*forget\s*:\s*([^\]]+?)\s*\]\]/i);
  if (fgk) forgetMemory(fgk[1]);
  // 抠掉所有标记（已识别的 + 任何残留的 [[...]]），保证一个字都不会被读出来/显示
  t = t.replace(/\[\[[^\]]*\]\]/g, '');
  return t.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

// ───────────────────────── ElevenLabs 发声（ffmpeg 加电话失真 → afplay 播）─────────────────────────
// 声音过一层「电话/对讲机」效果：带通 350–3400Hz 砍掉高低频 + 轻 bitcrush 失真 + 推一点过载。
// 默认开；COACH_VOICE_FX=0 关；COACH_VOICE_FX_FILTER 自定义 ffmpeg 滤镜串。
let VOICE_FX = process.env.COACH_VOICE_FX !== '0';
// filter_complex：人声走电话带通+轻 bitcrush（电子/对讲机感），不混底噪。
// [0:a]=TTS 人声；带通 350–3400Hz + acrusher 轻失真 + 过载 → 限幅收尾。
const VOICE_FX_COMPLEX = process.env.COACH_VOICE_FX_COMPLEX ||
  '[0:a]highpass=f=350,lowpass=f=3400,acrusher=bits=8:samples=1:mode=log:mix=0.3,volume=2.6,alimiter=limit=0.9[out]';
let currentAfplay = null;   // 当前播放/处理子进程（afplay 或 ffmpeg）——打断时杀它
let ttsAborted = false;     // 打断/暂停时置 true，让处理中的 FX 别再继续播
let turnAborted = false;    // 整轮被点击打断：思考阶段点也算，speakTTS 会据此拒绝开口（一轮开始才清零）
let ttsVolume = 1.0;        // 桌宠说话音量（右键菜单调；afplay -v，0=静音 1=正常）
function speakTTS(text) {
  return new Promise(async (resolve) => {
    if (turnAborted) { resolve(); return; }   // 这轮在思考/合成期间已被点击打断 → 根本不开口
    ttsAborted = false;
    _bargeBytes = 0; if (BARGE_VOICE && sessionActive && !panelHidden && !mic) startMic();   // 开口前确保主麦在跑 → 说话期间能监听你打断
    try { if (currentAfplay) { currentAfplay.kill('SIGKILL'); currentAfplay = null; } } catch (_) {}  // 掐掉正在播的垫播音,真回复接管
    let done = false; const fin = () => { if (!done) { done = true; currentAfplay = null; resolve(); } };
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.4, similarity_boost: 0.75 } }),
      });
      if (!r.ok) { fin(); return; }
      const raw = join(tmpdir(), 'coach_tts.mp3');
      writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
      let toPlay = raw;
      if (VOICE_FX) {
        const fx = join(tmpdir(), 'coach_tts_fx.wav');
        const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-filter_complex', VOICE_FX_COMPLEX, '-map', '[out]', fx]);
        currentAfplay = ff;   // 处理期间也能被打断掐掉
        const ok = await new Promise((res) => { ff.on('exit', (c) => res(c === 0)); ff.on('error', () => res(false)); });
        if (ttsAborted || done) { fin(); return; }   // 处理途中被打断 → 不播
        if (ok) toPlay = fx;                          // 处理失败 → 退回原声
      }
      if (ttsAborted || done) { fin(); return; }
      const af = spawn('afplay', ['-v', String(ttsVolume), toPlay]); currentAfplay = af;
      af.on('exit', fin); af.on('error', fin);
    } catch (_) { fin(); }
  });
}

// ───────────────────────── 垫播"收到"反应音(语音上传时随机播一条,垫住转写+思考的等待空档)─────────────────────────
// 素材由 generate-acks.js 预生成到 acks/(同款电话音效)。真回复的 speakTTS 一开口就会掐掉这条垫播。
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
// acks/ 里 ack_01..40 = 短"收到"(上传/转写时播), ack_41..80 = 长"思考"(大脑思考时播)。
let ACK_SHORT = [], ACK_LONG = [];
try {
  for (const f of readdirSync(join(ENGINE_DIR, 'acks')).filter((x) => /\.(wav|mp3)$/i.test(x))) {
    const n = parseInt((f.match(/(\d+)/) || [])[1] || '0', 10);
    (n > 40 ? ACK_LONG : ACK_SHORT).push(join(ENGINE_DIR, 'acks', f));
  }
} catch (_) {}
const pickAck = (arr) => arr[Math.floor(Math.random() * arr.length)];
// 播一条垫场音(pool=ACK_SHORT 上传时 / ACK_LONG 思考时);真回复的 speakTTS 一开口会掐掉它。
function playAck(pool) {
  if (ttsVolume <= 0 || !pool || !pool.length) return;     // 静音/没素材 → 不垫
  try { if (currentAfplay) currentAfplay.kill('SIGKILL'); } catch (_) {}
  const a = spawn('afplay', ['-v', String(ttsVolume), pickAck(pool)]);
  currentAfplay = a;
  a.on('exit', () => { if (currentAfplay === a) currentAfplay = null; });
  a.on('error', () => { if (currentAfplay === a) currentAfplay = null; });
}

// ───────────────────────── 状态 + 半双工 ─────────────────────────
let sessionActive = false; // 练习中？（连点4次 /toggle-session 切换）
let paused = false;        // 会话内手动暂停（Control+Esc）
let speaking = false;      // 桌宠正在说话
let forwarding = false;    // 是否把麦克风 PCM 喂给 Scribe 采集（半双工开关）
let pendingFinals = [], flushTimer = null;
let lastTyped = false;     // 上一轮是不是打字输入的 → 下一轮默认进打字预备态（不开麦）

// 生命周期动画。倾听=持续循环一段具体动画(headphones-groove)；其余用会话状态(状态一变会自动取消倾听动画)
const LISTEN_ANIM = process.env.COACH_LISTEN_ANIM || 'clawd-idle-look.svg'; // 倾听=看着你（不是听歌）
const SPEAK_ANIM  = process.env.COACH_SPEAK_ANIM  || 'clawd-speak-once.svg';        // 说话：单次弹跳（一跳即停，不循环→不会被切坏）
const SPEAK_MS    = Number(process.env.COACH_SPEAK_MS || 1400);                     // 一跳 1s 早落地静止，1400ms 稳稳收
const ST_THINK = process.env.COACH_STATE_THINK || 'thinking'; // 它在想
const ST_IDLE  = process.env.COACH_STATE_IDLE  || 'idle';     // 底色 / 收尾 / 暂停
const ST_WORK  = process.env.COACH_STATE_WORK  || 'working';  // 干活 / 调工具 / 切模型 → 打字动画
const ST_ALERT = process.env.COACH_STATE_ALERT || 'notification'; // 「!」惊讶/提醒（被点击打断时）
const ST_HAPPY = process.env.COACH_STATE_HAPPY || 'attention'; // 开心（开场 / 完成）
const ST_ERR   = process.env.COACH_STATE_ERR   || 'error';    // 出错 / 超时

function resumeListen() {
  speaking = false; _bargeBytes = 0;
  // 上一轮是打字 → 这轮默认进「打字预备态」：不开麦、输入框就绪聚焦（连续打字不用每轮重点）
  const typeMode = lastTyped && !paused;
  forwarding = sessionActive && !paused && !panelHidden && !typeMode;   // 暂停/隐藏/打字预备 都不录
  resetCapture();                          // 清空残留音频/半句，下一轮干净开始
  if (sessionActive && !panelHidden) {
    if (forwarding) { startMic(); sayPet('', ST_IDLE, LISTEN_ANIM); }   // 语音倾听
    else sayPet('', ST_IDLE);                                            // 暂停 / 打字预备 → 不开麦
    chat({ type: 'input' });               // 聊天栏出现可打字输入框
    chat({ type: 'lock', on: paused });    // 暂停态 → 灰（仍可打字）；否则正常
    if (typeMode) chat({ type: 'typeready' });   // 直接进打字预备态（输入框聚焦就绪、麦关）
    bumpIdle();                            // 启动无操作自动隐藏倒计时
  }
}

// 点击打断（barge-in）：只在它正说话(TTS 播放中)时生效。先给「!」表情，再掐掉语音 →
// speakTTS resolve → handleUtterance 的 finally 走 resumeListen，自动开你的回合（唤出输入框）。
const ALERT_ANIM = process.env.COACH_ALERT_ANIM || 'clawd-react-double-jump.svg'; // 打断时:头顶大感叹号 + 惊吓跳
function doBarge() {
  if (!sessionActive || paused || panelHidden || !speaking) return false;
  // 「!」惊吓跳：只发叠加动画，base 用 idle —— 千万别用 'notification' 状态，那是「举着灯泡」的图！
  // （叠加动画能挺过随后 resumeListen 的 setState，确保看得见这一下。）
  sayPet('', ST_IDLE, ALERT_ANIM, 900);
  turnAborted = true; _bargeBytes = 0;                                                  // 整轮作废：思考阶段点也算，回复回来也不会开口
  ttsAborted = true; if (currentAfplay) { try { currentAfplay.kill('SIGKILL'); } catch (_) {} }  // 立刻掐掉正在播 / 正在合成的语音（SIGKILL 瞬停，不等优雅退出）
  // 还在思考（大脑没出结果、还没开口）→ 立刻取消这轮等待，马上把话筒还给你，别等它生成完
  if (pending) { const p = pending; pending = null; clearTimeout(p.timer); try { p.resolve(''); } catch (_) {} }
  console.log('  [barge] 点击打断 → 轮到你说');
  return true;
}
// 完整答案进聊天栏；TTS 只念能开口的部分。coach 回复本就短 → 原样念；
// agent 回复可能含代码/路径/markdown → 剥成口语，整段念完（列表也逐条念）；
// 只有【真的特别长】才按句累加到上限、再提示看屏幕（默认 1200 字，可用 COACH_SPOKEN_MAX 调）。
const SPOKEN_MAX = Number(process.env.COACH_SPOKEN_MAX || 1200);
function spokenFrom(text) {
  if (currentMode !== 'agent') return text;
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ')          // 代码块
       .replace(/`([^`]+)`/g, '$1')              // 行内代码
       .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // 标题井号
       .replace(/^\s*[-*+]\s+/gm, '')             // 无序列表符号 - * +
       .replace(/^\s*\d+[.)]\s+/gm, '')           // 有序列表 1. 2) … —— 去掉编号，避免「1.」被当成句末误断
       .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') // 粗/斜体
       .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // 链接留文字
       .replace(/https?:\/\/\S+/g, '')            // 裸链接
       // 兜底：清掉 emoji / 表情符 / 箭头 / 项目符号，TTS 念不出来
       .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2022}\u{25A0}-\u{25FF}\u{FE0F}\u{200D}]/gu, ' ')
       .replace(/->|=>/g, ' ')                    // 箭头 → 空格
       .replace(/\s*&\s*/g, ' and ');             // & → and
  // 逐行整理：每个非空行当作一句，行末没句末标点就补个句号 → TTS 会逐条停顿、把列表一条条念清楚，
  // 而不是连成一坨或被列表编号的点号截断。
  t = t.split('\n').map((s) => s.trim()).filter(Boolean)
       .map((s) => (/[。.!?！？:：,，;；]$/.test(s) ? s : s + '.'))
       .join(' ')
       .replace(/[*_`~#|>]+/g, ' ')               // 残留 markdown/符号串 → 空格
       .replace(/\s+/g, ' ').trim();
  if (t.length <= SPOKEN_MAX) return t;           // 正常长度 → 整段念完（不再砍成前两句）
  // 真的太长 → 按句累加到上限为止，再提示看屏幕（不是硬砍 2 句，尽量多念）
  const sentences = t.match(/[^。.!?！？]+[。.!?！？]?/g) || [t];
  let head = '';
  for (const s of sentences) { if ((head + s).length > SPOKEN_MAX) break; head += s; }
  if (!head) head = t.slice(0, SPOKEN_MAX);
  return head.trim() + ' … the rest is on the screen.';
}

// 识别「切模型 / 切模式」控制指令（命中就不喂给大脑，免得大脑扯 /fast /config）。
function parseCommand(text) {
  const t = text.trim();
  // 重命名当前会话。先抓最直接的写法；再走「提到会话/对话/session + 有改名意图 → 抽叫做/改成/为…后面的名字」。
  let r = t.match(/^\/(?:rename|name)\s+(.+)$/i)
       || t.match(/^(?:重命名|改名|命名|起名|取名)\s*(?:这个|当前)?\s*(?:会话|对话)?\s*(?:为|成|叫做?|：|:)?\s*(.+)$/)
       || t.match(/^rename(?:\s+(?:this\s+)?(?:session|conversation|chat))?\s*(?:to|as|：|:)?\s*(.+)$/i);
  if (!r) {
    const aboutSession = /(session|会话|对话|这次|这一次|这段)/i.test(t);
    const renameIntent = /(重命名|改名|命名|起名|取名|名字|名称|叫做|叫成|rename|\bname\b)/i.test(t);
    if (aboutSession && renameIntent) {
      // 名字在这些「引入词」之后（长的排前面，免得「叫做」被「叫」截断）
      r = t.match(/(?:叫做|叫成|叫作|改名为|改名叫|命名为|名字\s*(?:改成|改为|叫做|叫|是|为|设成|设为)?|名称\s*(?:为|是)?|改成|改为|设成|设为|named|called|name\s+(?:it|this)?\s*(?:to|as)?|rename\s+(?:it|this)?\s*(?:to|as)?|\bto\b|\bas\b|：|:|叫|为)\s*(.+)$/i);
    }
  }
  if (r && r[1] && r[1].trim()) return { kind: 'rename', title: r[1].trim().replace(/^["'“”]+|["'“”。.!！?？]+$/g, '') };

  // ── 记忆/认得你（本地直接存，不喂大脑 → 即时回执 + resume 重启让大脑立刻吃到新档案）──
  // 清空：「忘记我」连名字一起清；「清空记忆/忘掉所有」只清事实留名字。都要求整句就是这个意思（锚定），别误吃「忘掉我喜欢简短」。
  if (/^(?:忘记我(?:吧|了)?|forget me)[。.!！]?$/i.test(t)) return { kind: 'forget', all: true, wipeName: true };
  if (/^(?:清空(?:记忆|所有记忆|全部记忆)?|忘(?:掉|记)(?:所有|全部|一切)(?:记忆|事情|的事)?|全部忘(?:掉|记)|forget everything|forget all|clear (?:your |all )?memory|wipe (?:your )?memory)[。.!！]?$/i.test(t))
    return { kind: 'forget', all: true };
  // 删某条：忘掉X / 别记着X了 / forget X（锚在句首；「别忘了X」不在此列，那是「记住」）
  let fg = t.match(/^(?:忘(?:掉|记)(?:一下)?|别记(?:着|住)了?|删(?:掉|除)记忆)\s*[:：,，]?\s*(.+)$/)
        || t.match(/^(?:forget|drop|remove)\s+(?:that\s+)?(?:i\s+)?(.+)$/i);
  if (fg && fg[1] && fg[1].trim()) return { kind: 'forget', text: fg[1].trim().replace(/^["'“”]+|["'“”。.!！?？]+$/g, '') };
  // 设名字（保守：单个短 token、整句就这意思，避免「我是说…/I'm tired」误判；含糊的留给大脑用 [[remember]] 兜）
  let nm = t.match(/^(?:我(?:就)?叫|叫我|请叫我|你可以叫我|我(?:的)?名字(?:是|叫))\s*([^\s，。,.!！?？]{1,20})\s*[。.!！~]?$/)
        || t.match(/^(?:my name is|call me|you can call me)\s+([a-z][a-z .'-]{0,20})\s*[.!]?$/i);
  if (nm && nm[1] && nm[1].trim()) return { kind: 'setname', name: nm[1].trim() };
  // 记一条：记住X / 记一下X / 别忘了X / remember X / note X
  let rmem = t.match(/^(?:记住|记一下|记下来?|记一记|帮我记(?:住|一下|下来?)?|别忘了?|别忘记)\s*[:：,，]?\s*(.+)$/)
          || t.match(/^(?:remember|note|keep in mind|don'?t forget)\s*(?:that\s+)?[:：,]?\s*(.+)$/i);
  if (rmem && rmem[1] && rmem[1].trim()) return { kind: 'remember', text: rmem[1].trim() };

  // 斜杠：/model opus、/opus
  let m = t.match(/^\/(?:model\s+)?(haiku|sonnet|opus)\b/i);
  if (m) return { kind: 'model', model: m[1].toLowerCase() };
  // 自然语言：句中恰好提到一个模型名 + 有「切换意图」词 → 直接切到该模型。
  // 两个以上模型名（如「opus 和 sonnet 啥区别」）视为提问，不切。
  const found = (t.match(/\b(haiku|sonnet|opus)\b/ig) || []).map((s) => s.toLowerCase());
  const uniq = [...new Set(found)];
  const wantsSwitch = /(switch|change|set|use|swap|go to|go with|model to|to (?:haiku|sonnet|opus)|切到|切换|换成?|改用|改成|换模型|切模型|换个?模型|用)/i.test(t);
  if (uniq.length === 1 && wantsSwitch) return { kind: 'model', model: uniq[0] };
  // 光说一个模型名（短句）也当切换
  m = t.match(/^(haiku|sonnet|opus)\s*(?:模型|模式)?[。.!！]?$/i);
  if (m) return { kind: 'model', model: m[1].toLowerCase() };
  m = t.match(/^\/coach(?:\s+(\w+))?\b/i);                                                      // /coach、/coach alignment
  if (m) return { kind: 'mode', mode: 'coach', scenario: (m[1] || 'free').toLowerCase() };
  if (/^\/agent\b/i.test(t)) return { kind: 'mode', mode: 'agent' };
  if (t.length <= 16 && /(英语陪练|练英语|口语陪练|陪我练|coach\s*模式)/i.test(t)) return { kind: 'mode', mode: 'coach', scenario: 'free' };
  if (t.length <= 16 && /(退出陪练|回到助手|普通模式|助手模式|退出英语|agent\s*模式)/i.test(t)) return { kind: 'mode', mode: 'agent' };
  // 音量(本地直接调,不喂大脑):静音 / 恢复 / 具体百分比 / 大点 / 小点
  // 「闭嘴 / 别说话」→ 桌宠受惊（感叹号「!」动画）+ 缩到角落，且不出声回嘴。「静音 / mute」仍走音量=0。
  if (/(闭嘴|闭上嘴|住口|别说(?:话|了)|别讲(?:话|了)|别出声|安静(?:点|一下|些)?|shut\s*up|be\s*quiet|hush|zip it|quiet down|stop talking)/i.test(t)
      && !/(取消|恢复|unmute|大声|大点|继续|别安静)/i.test(t))
    return { kind: 'pet', anim: 'alert', mini: true, ack: '' };
  if (/(静音|mute)/i.test(t) && !/(取消|恢复|unmute)/i.test(t)) return { kind: 'volume', level: 0 };
  if (/(取消静音|恢复音量|声音恢复|unmute)/i.test(t)) return { kind: 'volume', level: 1 };
  const vp = t.match(/(?:音量|声音|volume)\D{0,4}(\d{1,3})\s*%?/i);
  if (vp) return { kind: 'volume', level: Math.max(0, Math.min(100, parseInt(vp[1], 10))) / 100 };
  if (t.length <= 18 && /(大点声|大声|声音大|大一点|响一点|响点|louder|turn (?:it|the volume) up|volume up|speak up)/i.test(t)) return { kind: 'volume', delta: 0.25 };
  if (t.length <= 18 && /(小点声|小声|声音小|小一点|轻一点|轻点|quieter|turn (?:it|the volume) down|volume down|too loud)/i.test(t)) return { kind: 'volume', delta: -0.25 };

  // ── Claude 桌宠自控（本地直接执行，不喂大脑 → 100% 听得懂、零延迟，不靠大脑临场发标记）──
  const petCmd = parsePetCommand(t);
  if (petCmd) return petCmd;
  return null;
}

// 识别「让桌宠调整自己」的口令：变大变小 / 缩到角落(mini) / 表演某个动画。中英都认。
// 故意宽松好触发，但用「自指 / 很短 / 排除其它对象」几道闸避免误吃正常对话（如「把字体变大」）。
function parsePetCommand(t) {
  const zh = /[一-鿿]/.test(t);
  const selfRef = /(你自己|你|yourself|your\s*self|自己)/i.test(t);
  // 一次性动画：情绪/动作词 + 表演类动词，或直白祈使短语（开心一下 / 挥挥手 …）
  const performVerb = /(表演|表现|演(?:个|一个|一下)?|做(?:个|一个|出|一下)?|来(?:个|一个|段|一下)?|卖|给我来|play|do|show|perform|give me|act out)/i.test(t);
  const ANIM_INTENT = [
    { re: /(开心|高兴|兴奋|快乐|庆祝|happy|cheer|excited|celebrate|yay)/i, anim: 'happy', ack: zh ? '好，开心一下！' : 'Yay!' },
    { re: /(挥手|招手|打招呼|挥挥手|挥个手|wave|say\s*hi|greet)/i,           anim: 'wave',  ack: zh ? '嗨！' : 'Hi there!' },
    { re: /(晕|转圈|转晕|懵|confus|dizzy|spin)/i,                          anim: 'dizzy', ack: zh ? '哎呀，转晕啦。' : 'Whoa, dizzy.' },
    { re: /(哈欠|打哈欠|犯困|好困|yawn|sleepy)/i,                          anim: 'yawn',  ack: zh ? '（打个哈欠）' : 'Yawn.' },
    { re: /(听歌|音乐|跳舞|蹦迪|摇摆|dance|dancing|music|groove|jam)/i,      anim: 'music',   ack: zh ? '来段舞！' : 'Let me dance!' },
    { re: /(杂技|耍一?个|表演个|魔术|juggle|juggling|acrobat|trick|perform a)/i, anim: 'juggle', ack: zh ? '看我表演！' : 'Showtime!' },
    { re: /(张望|看一?看|东张西望|peek|look around)/i,                      anim: 'look',  ack: zh ? '我看看。' : 'Let me look.' },
    { re: /(思考|想一?想|沉思|ponder)/i,                                   anim: 'think', ack: zh ? '让我想想。' : 'Thinking.' },
    { re: /(提醒|注意|警示|alert|attention|heads\s*up)/i,                  anim: 'alert', ack: zh ? '注意！' : 'Heads up!' },
  ];
  const standaloneAnim = /^(开心一下|高兴一下|卖个萌|挥挥手|挥个手|招招手|打个哈欠|转个圈|做个鬼脸|cheer up|wave|do a little dance)[!！。.~]*$/i.test(t);
  // 很短的句子（基本就是那个动作词本身，如「dance」「跳舞」「杂技」）也算口令，不用带「表演」动词
  const shortAnim = t.trim().replace(/[!！。.,，?？~]/g, '').length <= 8;
  for (const a of ANIM_INTENT) {
    if (a.re.test(t) && (performVerb || standaloneAnim || shortAnim)) return { kind: 'pet', anim: a.anim, ack: a.ack };
  }

  // 缩到角落 / mini 模式 / 回来。「mini」这个词本身就够特征化 → 短句里出现就算（覆盖「再换到 mini mode」）。
  const miniWord = /\bmini\b/i.test(t) || /mini\s*mode|minimode|mini\s*模式|迷你/i.test(t);
  const toCorner = /(去(?:待在|呆在)?角落|到角落|缩到角落|躲(?:到|进)?(?:角落|一边|旁边)|让开|别挡(?:着|路)?|到旁边(?:去|待着)?|靠边(?:站)?|minimi[zs]e|go to (?:the )?corner|get out of (?:the |my )?way|out of my way|hide in (?:the )?corner|tuck (?:yourself )?away|step aside|move aside)/i.test(t);
  const comeBack = /(回来|出来|回到中间|变回来|别躲(?:了|啦)?|come back|full[\s-]?size|un-?minimi[zs]e|unmini|exit mini|come out|get back)/i.test(t);
  // 先判「回来/退出 mini」，再判「进 mini」——避免「退出 mini mode」里的 mini 把它判成进入
  if (comeBack && (selfRef || miniWord || t.length <= 14)) return { kind: 'pet', mini: false, ack: zh ? '好，我回来啦。' : 'Okay, I am back.' };
  if (toCorner || (miniWord && t.length <= 24)) return { kind: 'pet', mini: true, ack: zh ? '好，我去角落待着。' : 'Okay, going mini.' };

  // 变大 / 变小 / 恢复正常大小 —— 排除明显指别的东西（字体/窗口/图片/声音…），再要求自指或很短
  const mentionsOther = /(字体|字号|文字|font|窗口|window|图片|图像|画面|image|照片|photo|地图|map|视频|video|页面|page|浏览器|browser|声音|音量|volume)/i.test(t);
  if (!mentionsOther) {
    const normalSize = /(正常大小|默认大小|恢复大小|恢复原状|中等大小|普通大小|normal size|default size|medium size|reset.*size)/i.test(t);
    const bigger = /(变大|大一点|大一些|大点|大些|放大|再大|更大|最大|bigger|larger|grow|enlarge|get big|biggest)/i.test(t);
    const smaller = /(变小|小一点|小一些|小点|小些|缩小|再小|更小|最小|smaller|shrink|tinier|get small)/i.test(t);
    if (normalSize) return { kind: 'pet', size: 'M', ack: zh ? '好，恢复正常大小。' : 'Back to normal size.' };
    if (bigger && (selfRef || t.length <= 12)) return { kind: 'pet', size: 'L', ack: zh ? '好，我变大啦。' : 'Okay, big now.' };
    if (smaller && (selfRef || t.length <= 12)) return { kind: 'pet', size: 'S', ack: zh ? '好，我缩小啦。' : 'Okay, smaller now.' };
  }
  return null;
}

// 切模型：resume 同一 session 保上下文。切模式：换了系统提示 → 重开新会话（重置上下文）。
function switchModel(model) {
  if (model === currentModel) return `Already on ${model}.`;
  const prev = currentModel; currentModel = model;
  startBrain(currentMode, currentScenario, currentModel, currentSessionId || undefined);
  console.log(`  ⇄ 模型 ${prev} → ${model}`);
  return `Okay, switched to ${model}.`;
}
function switchMode(mode, scenario) {
  currentMode = mode;
  if (scenario) currentScenario = scenario;
  startBrain(currentMode, currentScenario, currentModel);
  console.log(`  ⇄ 模式 → ${mode}${scenario ? '/' + scenario : ''}`);
  return mode === 'coach' ? `English coach mode on (${currentScenario}).` : 'Back to assistant mode. Put me to work.';
}

async function handleUtterance(text, oneShot) {
  const hasImg = pendingImages.length > 0;        // 这一轮带粘贴的图片(纯图也放行,可多张)
  text = text || '';
  // 没开会话 / 正在说话 → 不处理。
  if (!sessionActive || speaking) { console.log('[utter] 丢弃:sessionActive=' + sessionActive + ' speaking=' + speaking + '（没开/正在说话）'); return; }
  // 面板"隐藏"时:语音(oneShot)是隐藏期残留,丢；但打字进来说明面板其实可见(否则你打不了字)→ 自愈引擎的隐藏标记,继续处理。
  if (panelHidden) {
    if (oneShot) { console.log('[utter] 丢弃:面板已隐藏(语音残留)'); return; }
    console.log('[utter] 打字进来但 panelHidden=true → 自愈为可见,继续');
    panelHidden = false;
  }
  if (!hasImg && text.trim().length <= 1) { console.log('[utter] 丢弃:文字太短且无图'); return; }
  if (oneShot && paused) return;
  const trimmed = text.trim();
  // 斜杠命令:/clear|/reset|/new → 本地清空开新会话(等价 Claude Code 的 /clear)。其它 /命令(/compact 等)透传给大脑。
  if (!hasImg && (trimmed === '/clear' || trimmed === '/reset' || trimmed === '/new')) { console.log('  [cmd] /clear → 新会话'); newSession(); return; }
  speaking = true; forwarding = false;            // 半双工：先闭麦再开口
  turnAborted = false;                            // 新一轮开始 → 清掉上一轮的打断标记
  toolUsedThisTurn = false;
  const mine = trimmed;
  const isSlash = !hasImg && mine.startsWith('/');   // 透传给大脑的 Claude Code 斜杠命令(/compact 等)
  try {
    // oneShot(语音一次性转写)→ 气泡放大展开+文字渐显；打字/流式 → 直接顶上去。
    // 斜杠命令 → 气泡走 'cmd' 黑色变体；粘贴的图片 → 带 image 让气泡里方形预览。
    const imgUrls = pendingImages.map((im) => `data:${im.media_type};base64,${im.data}`);
    chat({ type: 'add', role: 'user', text: mine, anim: oneShot ? 'grow' : null, variant: isSlash ? 'cmd' : undefined, images: imgUrls.length ? imgUrls : undefined });
    console.log(`\n  你: ${mine}${hasImg ? ' [+image]' : ''}`);

    // 先拦控制指令（切模型/模式/重命名/音量/桌宠），不喂给大脑。带图片 → 不拦,直接走大脑当对话。
    const cmd = hasImg ? null : parseCommand(mine);
    if (cmd) {
      if (cmd.kind !== 'pet') sayPet('', ST_WORK, isSlash ? 'clawd-working-typing.svg' : null, isSlash ? 600000 : undefined);   // 命令处理→work;斜杠命令用 coding 打字动画
                                                     // pet 命令【不要】这一发——它会和紧接着的动画抢，甚至把动画盖掉（setState 会取消叠加动画）
      let ack = '', petAnim = null;
      try {
        if (cmd.kind === 'model') ack = switchModel(cmd.model);
        else if (cmd.kind === 'rename') { const name = renameSession(cmd.title); ack = `Renamed this session to "${name}".`; }
        else if (cmd.kind === 'volume') {
          ttsVolume = (typeof cmd.level === 'number')
            ? Math.max(0, Math.min(1, cmd.level))
            : Math.max(0, Math.min(1, ttsVolume + (cmd.delta || 0)));
          ack = ttsVolume === 0 ? '好,我先静音。' : `好,音量调到 ${Math.round(ttsVolume * 100)}% 了。`;
        }
        else if (cmd.kind === 'pet') {                // 桌宠自控：本地直接执行，绝不喂大脑
          if (cmd.size) petControl({ size: cmd.size });
          if (cmd.anim) petAnim = animSvg(cmd.anim);  // 把请求的动画当作「说话动画」播，别被默认弹跳覆盖
          if (typeof cmd.mini === 'boolean') {
            // 动画 + 缩到角落（如「闭嘴」=受惊 + 躲走）→ 先让「!」露一下再缩，别同帧把惊吓盖掉
            if (cmd.anim && cmd.mini) setTimeout(() => petControl({ mini: true }), 650);
            else petControl({ mini: cmd.mini });
          }
          ack = cmd.ack ?? '好。';                     // 显式空串 = 不出声（被叫闭嘴就别回嘴），只做动作
          console.log(`  [pet] ${JSON.stringify(cmd)}`);
        }
        else if (cmd.kind === 'remember') {            // 记一条 → 落盘 + resume 重启让大脑立刻吃到（这条没喂给大脑）
          const zh = /[一-鿿]/.test(mine);
          addMemory(cmd.text); refreshBrainMemory();
          petAnim = 'clawd-notification.svg';          // 「记下了」举灯泡
          ack = zh ? '好，我记住了。' : "Got it, I'll remember that.";
        }
        else if (cmd.kind === 'setname') {             // 记名字
          const zh = /[一-鿿]/.test(mine);
          const nm = setName(cmd.name); refreshBrainMemory();
          petAnim = 'clawd-happy.svg';
          ack = zh ? `好的，${nm}，我记住啦。` : `Nice to meet you, ${nm}. I'll remember that.`;
        }
        else if (cmd.kind === 'forget') {              // 删一条 / 清空
          const zh = /[一-鿿]/.test(mine);
          if (cmd.all) { clearMemory(cmd.wipeName); ack = cmd.wipeName ? (zh ? '好，关于你的记忆我都清空了。' : "Okay, I've cleared everything I knew about you.") : (zh ? '好，我把记住的事都清空了。' : "Okay, I've cleared what I remembered."); }
          else { const n = forgetMemory(cmd.text); ack = n ? (zh ? '好，我忘掉了。' : 'Okay, I forgot that.') : (zh ? '我记忆里没有这条。' : "I don't have that in my memory."); }
          refreshBrainMemory();
          petAnim = 'clawd-happy.svg';
        }
        else ack = switchMode(cmd.mode, cmd.scenario);
      } catch (e) { ack = '切换失败：' + e.message; }
      if (!sessionActive || panelHidden || turnAborted) return;
      if (ack) chat({ type: 'add', role: 'coach', text: ack, variant: isSlash ? 'cmd' : undefined });
      sayPet('', ST_IDLE, petAnim || (isSlash ? 'clawd-working-typing.svg' : SPEAK_ANIM), petAnim ? ANIM_MS : SPEAK_MS);
      const animAt = Date.now();
      if (ack && !isSlash) await speakTTS(ack);   // 斜杠命令:处理时不出声
      // 一次性动画必须真正露出来：这轮 return 后 finally 的 resumeListen 会【立刻】把它切回倾听动画
      // （renderer 里 setState 会 cancelReaction 掉叠加动画）。所以兜一个最短停留——
      // 哪怕 ack 很短 / TTS 秒回 / 没声音，也先让动画播够再交回去。
      if (petAnim) {
        const shown = Date.now() - animAt, MIN_SHOW = 1700;
        if (shown < MIN_SHOW) await new Promise((r) => setTimeout(r, MIN_SHOW - shown));
      }
      return;
    }

    recordTurn('user', mine || '[image]');           // 进会话记录（命令切换不记）
    lastTyped = !oneShot;                            // 记住这轮是打字还是语音 → 决定下轮默认模式
    // 思考：opus 用「超级思考」动画，sonnet/haiku 用普通思考
    if (isSlash) sayPet('', ST_WORK, 'clawd-working-typing.svg', 600000);   // 斜杠命令:coding 动画,不垫思考音、不出声
    else { sayPet('', ST_THINK, currentModel === 'opus' ? 'clawd-working-ultrathink.svg' : null, currentModel === 'opus' ? 600000 : undefined); playAck(ACK_LONG); }
    let reply = '', errored = false;
    try { reply = await ask(mine); }
    catch (e) {
      console.error('  [brain]', e.message);
      // 僵尸会话:claude 端文件丢了(首轮就失败、没建成),--resume 永远 "No conversation found"。
      // → 丢掉坏的 session,起一个全新的(无 resume),把这轮重发一次,自动救活,不用用户手动新建。
      if (/no conversation found|session id/i.test(e.message)) {
        console.error('  [brain] 会话丢失 → 起全新 session 重试这轮');
        try { startBrain(currentMode, currentScenario, currentModel); reply = await ask(mine); }
        catch (e2) { console.error('  [brain] 重试仍失败:', e2.message); errored = true; reply = brainErrMsg(e2.message); }
      } else { errored = true; reply = brainErrMsg(e.message); }
    }
    // 关键：生成期间若已结束/隐藏/被点击打断 → 别再说话（否则关了/打断了还在说）
    if (!sessionActive || panelHidden || turnAborted) return;
    // Claude 自驱桌宠:回复里带 [[volume]] / [[size]] / [[mini]] / [[anim]] 等标记
    // → 应用对应动作并从文本里抠掉(不显示/不朗读)。可能整段都是标记 → reply 变空、只剩动作。
    if (reply) reply = applyPetMarkers(reply);
    // Claude Code 斜杠命令(/compact 等)常返回空 → 给个明确回执,别让用户以为没反应。
    if (!reply && isSlash && !errored) reply = (mine === '/compact' ? 'Compacted the conversation.' : 'Done.');
    if (reply) {
      console.log(`  Coach: ${reply}`);
      if (!errored) recordTurn('coach', reply);        // 成功回复进会话记录
      chat({ type: 'add', role: 'coach', text: reply, variant: isSlash ? 'cmd' : undefined }); // 完整答案进聊天记录;斜杠命令走黑色变体
      const spoken = spokenFrom(reply);                  // agent 模式只念精简口语小结
      // 斜杠命令:不出声、coding 收尾;否则 出错→晕 / 干完活→开心 / 普通→说话单跳
      if (isSlash) sayPet('', ST_IDLE, 'clawd-working-typing.svg', 1200);
      else if (errored) sayPet('', ST_ERR, 'clawd-dizzy.svg', SPEAK_MS);
      else if (toolUsedThisTurn) sayPet('', ST_HAPPY, 'clawd-happy.svg', 1600);
      else sayPet('', ST_IDLE, SPEAK_ANIM, SPEAK_MS);
      if (spoken && !isSlash) await speakTTS(spoken);   // 斜杠命令:不发语音
    }
  } finally {
    // 无论正常/出错：保证 speaking 复位、（没隐藏则）恢复你的回合输入框（暂停时也给灰输入框）
    if (sessionActive && !panelHidden) resumeListen(); else speaking = false;
  }
}

// 连点4次：开/关练习
async function startSession() {
  if (sessionActive) return;
  stopIdleWake();                      // 进会话:停掉空闲唤醒(声纹/敲击),把麦克风让给 Scribe
  sessionActive = true; paused = false; panelHidden = false; lastTyped = false;   // 新会话默认语音
  petSound('confirm');                 // 双击开启：噔噔
  chat({ type: 'show' });              // 确保面板可见（清掉上次 stop 时的 hide 状态）
  speaking = true; forwarding = false; turnAborted = false; resetCapture();
  // 接着上次会话（有记录）→ 不调模型、不开场白。面板若已装着这份内容（双击隐藏再开）就直接复现、
  // 不重刷；只有引擎刚启动/刚切会话（panelLoaded=false）才重建。全新会话 → 清空 + 开场。
  if (transcript.length > 0) {
    console.log(`\n  ▶ 继续上次会话（${currentMode} / ${currentModel}，${transcript.length} 条${panelLoaded ? '，面板复用' : '，重建面板'}）`);
    if (!panelLoaded) restorePanel();   // 面板没这份内容才重建；双击隐藏再开则跳过
    sayPet('', ST_IDLE, 'clawd-wake.svg', 1300);   // 继续会话 = 醒过来
  } else {
    chat({ type: 'clear' });
    console.log(`\n  ▶ 开始（${currentMode} / ${currentModel}）`);
    sayPet('', ST_THINK);   // 开场白期间 → 思考动画
    try {
      if (currentMode === 'coach') {
        const hi = await ask(COACH_OPENER);  // 陪练：让 AI 先用英语开场
        if (hi && sessionActive) { console.log(`  Coach: ${hi}`); recordTurn('coach', hi); chat({ type: 'add', role: 'coach', text: hi }); sayPet('', ST_IDLE, SPEAK_ANIM, SPEAK_MS); await speakTTS(hi); }
      } else {
        // agent：不调模型，本地一句问候（省延迟），直接进入待命
        const hi = `Hey! Listen! Ask me anything, any time. (on ${currentModel} — say "use opus" or "switch to sonnet" to change models, "speak Chinese" to switch language.)`;
        if (sessionActive) { console.log(`  Coach: ${hi}`); chat({ type: 'add', role: 'coach', text: hi }); sayPet('', ST_HAPPY, SPEAK_ANIM, SPEAK_MS); await speakTTS('Hey! Listen! Ask me anything, any time!'); }
      }
    } catch (_) {}
  }
  panelLoaded = true;   // 这一程之后，面板已装着当前会话内容；下次双击隐藏再开就不重刷了
  if (sessionActive) resumeListen(); else speaking = false; // 没被关才进入你的回合
}
function stopSession() {
  if (!sessionActive) return;
  sessionActive = false; forwarding = false;
  ttsAborted = true; if (currentAfplay) { try { currentAfplay.kill(); } catch (_) {} }
  stopMic(); resetCapture(); clearIdle();
  panelHidden = false;
  chat({ type: 'hide' });
  console.log('\n  ■ 结束会话');
  sayPet('', ST_IDLE);
  startIdleWake();                     // 回到空闲:重启唤醒(声纹优先,敲两下兜底)
}


// ───────────────────────── ElevenLabs Scribe（批量：VAD 断句 → 说完整段再转写，自动认中英；无实时滚字） ─────────────────────────
const SPEECH_GATE = Number(process.env.COACH_SPEECH_GATE || 0.025); // 开口音量门（PCM RMS）
const SILENCE_MS_VAD = Number(process.env.COACH_SILENCE_MS || 2000); // 静默这么久才判说完（练英文停顿想词，放宽防截断）
let scribeBuf = [], scribeActive = false, scribeLastVoice = 0, scribeVoiced = 0;
// 这一段里"真有声"的字节数(过 SPEECH_GATE 的块累加)。挡掉:一个尖峰(关门/键盘)触发 2 秒采集、大半是静音 → 被 Scribe 幻听成短句。
const MIN_VOICED_BYTES = Number(process.env.COACH_MIN_VOICED_BYTES || 4800); // ~0.15s @16k 单声道;不够就当噪声,不送转写
// STT 对静音/回声的经典"幻听"短句:整段只有这些(去标点后)就丢掉,不冒气泡。
const HALLUC = new Set(['thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'thank you so much',
  'you', 'bye', 'bye bye', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm', 'so', 'yeah', 'the',
  '谢谢', '谢谢大家', '谢谢观看', '请订阅', '不吝点赞', '订阅', '字幕', '嗯', '哦', '啊', '呃']);
function normHall(t) { return String(t).toLowerCase().replace(/[\s.,!?;:'"。，！？、…\-—~·]+/g, ' ').trim(); }
function isHallucination(t, voicedBytes) {
  const n = normHall(t);
  if (!n) return true;
  if (HALLUC.has(n)) return true;                                  // 整段就是一句经典幻听
  if (voicedBytes < 9600 && n.split(' ').length <= 3) return true; // 几乎没人声(<0.3s)却出了 ≤3 词 → 多半幻听
  return false;
}
// 一把清掉所有「在途采集状态」，确保切换时机后不会把旧音频/残留半句当成新一轮发出去。
function resetCapture() {
  scribeBuf = []; scribeActive = false; scribeVoiced = 0;
  pendingFinals = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}
// 只有这些条件全满足才允许采集 / 断句 / 发送一轮
function canCapture() { return sessionActive && !paused && !speaking && forwarding; }
function pcmRms(buf) {
  let s = 0; const n = buf.length >> 1; if (!n) return 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(i) / 32768; s += v * v; }
  return Math.sqrt(s / n);
}
function wavHeader(dataLen) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b;
}
function scribeFeed(chunk) {
  if (!sessionActive || paused || panelHidden || speaking) { return; }  // 暂停/隐藏/说话中绝不采集
  const now = Date.now();
  if (pcmRms(chunk) > SPEECH_GATE) { scribeActive = true; scribeLastVoice = now; scribeVoiced += chunk.length; bumpIdle(); }  // 有人声 → 累加有声字节 + 重置闲置计时
  if (scribeActive) {
    scribeBuf.push(chunk);
    if (now - scribeLastVoice > SILENCE_MS_VAD) flushScribe();
  }
}
// 把一段 16k 单声道 WAV 转成文字。local=本机常驻 whisper-server（离线、模型只加载一次）；否则 ElevenLabs Scribe。
async function transcribe(wav) {
  if (STT === 'local') {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('response_format', 'json');
    try {
      const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: fd, dispatcher: directAgent });
      if (!r.ok) { console.error('[whisper]', r.status); return ''; }
      const j = await r.json();
      return (j.text || '').trim();
    } catch (e) { console.error('[whisper]', e.message, '（whisper-server 起来了吗？）'); return ''; }
  }
  const fd = new FormData();
  fd.append('model_id', 'scribe_v1');
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY }, body: fd });
  if (!r.ok) { console.error('[scribe]', r.status); return ''; }
  const j = await r.json();
  return (j.text || '').trim();
}
// 常驻 whisper-server：引擎启动时拉起，模型只加载一次。端口已被占（已有 server）就复用，不重开。
let whisperProc = null;
function startWhisperServer() {
  if (STT !== 'local' || whisperProc) return;
  const probe = http.request({ host: '127.0.0.1', port: WHISPER_PORT, method: 'HEAD', timeout: 600 }, () => {
    console.log(`[stt] 复用已在跑的 whisper-server @ :${WHISPER_PORT}`);   // 已有 → 不重开
  });
  probe.on('error', () => {   // 没有 → 拉起
    try {
      whisperProc = spawn(WHISPER_SERVER_BIN, ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-l', WHISPER_LANG], { stdio: 'ignore' });
      whisperProc.on('exit', () => { whisperProc = null; });
      console.log(`[stt] 拉起 whisper-server（${WHISPER_MODEL.split('/').pop()} @ :${WHISPER_PORT}，加载中…）`);
    } catch (e) { console.error('[stt] whisper-server 启动失败:', e.message); }
  });
  probe.on('timeout', () => probe.destroy());
  probe.end();
}
async function flushScribe() {
  if (!scribeActive) return;
  scribeActive = false;
  const pcm = Buffer.concat(scribeBuf); scribeBuf = [];
  const voiced = scribeVoiced; scribeVoiced = 0;
  // 时机不对（已暂停 / 它在说话 / 会话已停）→ 直接丢弃，绝不把这段当成一轮发出去
  if (!sessionActive || paused || panelHidden || speaking) { resetCapture(); return; }
  if (pcm.length < 8000) return; // < ~0.25s 当噪声丢掉
  if (voiced < MIN_VOICED_BYTES) { console.log('[stt] 这段几乎没人声(' + voiced + 'B)→ 当噪声丢掉,不送转写'); return; } // 尖峰触发的空采集 → 不冒幻听气泡
  forwarding = false;            // 转写期间停采
  chat({ type: 'uploading', on: true });   // 转写中 → 暂停键变转圈
  playAck(ACK_SHORT);                      // 上传/转写时:垫一条短"收到"音(hmm/I see…)
  try {
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
    const t = await transcribe(wav);
    if (t && isHallucination(t, voiced)) { console.log('[stt] 丢弃疑似幻听:', JSON.stringify(t)); chat({ type: 'uploading', on: false }); resumeListen(); return; }
    if (t) { chat({ type: 'uploading', on: false }); handleUtterance(t, true); return; }
  } catch (e) { console.error('[stt]', e.message); }
  chat({ type: 'uploading', on: false });  // 转写结束（失败/空）→ 停转圈
  resumeListen();
}

// ───────────────────────── ffmpeg 抓麦 → 推流 ─────────────────────────
// 实时音量 → 桌宠波形：算 PCM 的 RMS，节流 ~12/s 发给 clawd（chat type:'level'）
let _lastLevelTs = 0;
function emitMicLevel(chunk) {
  const now = Date.now();
  if (now - _lastLevelTs < 80) return;
  _lastLevelTs = now;
  const n = chunk.length >> 1;
  if (n === 0) return;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = chunk.readInt16LE(i << 1); sum += v * v; }
  const rms = Math.sqrt(sum / n);
  const level = Math.max(0, Math.min(1, rms / 2500)); // 说话 RMS 约 1k~6k → 0..1
  try { chat({ type: 'level', level: Math.round(level * 100) / 100 }); } catch (_) {}
}
let mic = null;
// 消噪：ffmpeg 自带 highpass(切低频嗡声) + afftdn(FFT 降噪)，直接加在采集链路里。
// 默认【关】：afftdn 降噪会把辅音抹糊、反而拉低 whisper 识别率，喂原声更准。MIC_DENOISE=1 才开。
const MIC_DENOISE = process.env.MIC_DENOISE === '1';
const MIC_AF = process.env.MIC_AF || 'highpass=f=90,afftdn=nr=12:nf=-25';
function startMic() {
  if (mic) return;
  const af = MIC_DENOISE ? ['-af', MIC_AF] : [];
  mic = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', MIC, ...af, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  if (MIC_DENOISE) console.log(`[mic] 消噪开启: ${MIC_AF}`);
  mic.stdout.on('data', (chunk) => {
    if (!sessionActive || panelHidden) return;
    if (speaking) { bargeWatch(chunk); return; }   // 它在说话/思考 → 不喂 Scribe,只盯你的音量找打断(你一开口就掐它)
    // 最硬的一道闸：暂停 / 没在收音 → 一律丢弃，绝不处理或发送
    if (!forwarding || paused) return;
    emitMicLevel(chunk);   // 实时音量 → 桌宠输入框波形
    scribeFeed(chunk); // ElevenLabs Scribe：累积 PCM + VAD 断句
  });
  mic.stderr.on('data', (d) => { const s = d.toString(); if (/error|denied|Permission/i.test(s)) console.error('[mic]', s.trim()); });
  mic.on('exit', (code) => {
    mic = null;
    console.error(`[mic] ffmpeg 退出 code=${code}（麦克风授权？设备 ${MIC}？）`);
    // 还在会话且该收音时意外退出 → 自动重启，避免「显示在录音但没声波/没录音」;说话期间也要在,否则打断监听断了
    const needMic = () => sessionActive && !panelHidden && ((!paused && forwarding) || (BARGE_VOICE && speaking));
    if (needMic()) setTimeout(() => { if (needMic() && !mic) startMic(); }, 500);
  });
}

// ───────────────────────── 暂停 / 隐藏（两个独立状态）─────────────────────────
function stopMic() { if (mic) { try { mic.kill('SIGKILL'); } catch (_) {} mic = null; } }

// ───────────────────────── 敲两下唤醒（麦克风冲击检测；无会话时常驻；不调大模型）─────────────────────────
// 现代 Mac 没有可用震动传感器,靠麦克风听「短促高幅脉冲」。两次脉冲间隔落在窗口内 → 拉起会话。
// 跟 Scribe 麦克风互斥(只在 !sessionActive 时跑),不抢设备。阈值可用环境变量调:
//   太吵误触 → 调高 COACH_KNOCK_GATE；敲了没反应 → 调低 GATE 或放宽 COACH_KNOCK_MAX_GAP。
let KNOCK_ENABLED = process.env.COACH_KNOCK !== '0';
const KNOCK_GATE = Number(process.env.COACH_KNOCK_GATE || 0.15);       // 触发脉冲的峰值门(峰值法;敲击尖峰通常 0.3+)
const KNOCK_RELEASE = Number(process.env.COACH_KNOCK_RELEASE || 0.07); // 峰值回落到此以下才重新武装(防一声长响被当多敲)
const KNOCK_MIN_GAP = Number(process.env.COACH_KNOCK_MIN_GAP || 90);   // 相邻两敲最小间隔(ms)
const KNOCK_MAX_GAP = Number(process.env.COACH_KNOCK_MAX_GAP || 700);  // 相邻两敲最大间隔(ms,超了算新序列)
const KNOCK_TIMES = Number(process.env.COACH_KNOCK_TIMES || 3);        // 敲几下唤醒
let knockMic = null, knockArmed = true, knockLast = 0, knockTrig = 0, knockCount = 0;
function pcmPeak(buf) {   // 块内最大瞬时幅度(0..1)。敲击是尖峰,用峰值才测得到(RMS 会被整块平均掉)
  let m = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const v = Math.abs(buf.readInt16LE(i)) / 32768; if (v > m) m = v; }
  return m;
}
function detectKnock(chunk) {
  const pk = pcmPeak(chunk);
  const now = Date.now();
  if (pk < KNOCK_RELEASE) { knockArmed = true; return; }  // 安静 → 重新武装
  if (pk < KNOCK_GATE || !knockArmed) return;
  knockArmed = false;                                       // 一次脉冲只记一下,回落后才再武装
  // 连续敲：相邻在 [MIN,MAX] 窗内就累加，否则当新序列第一拍；数到 KNOCK_TIMES 下才唤醒。
  if (knockLast && now - knockLast >= KNOCK_MIN_GAP && now - knockLast <= KNOCK_MAX_GAP) knockCount++;
  else knockCount = 1;
  knockLast = now;
  console.log(`[knock] 脉冲 ${knockCount}/${KNOCK_TIMES} peak=${pk.toFixed(2)}`);   // 调参用
  if (knockCount >= KNOCK_TIMES && now - knockTrig > 2000) {
    knockTrig = now; knockCount = 0; knockLast = 0;
    console.log(`[knock] 敲${KNOCK_TIMES}下 → 唤醒`);
    wakeToRecording();
  }
}
// 敲击监听只在「没在主动收音」时跑（无会话 或 会话被隐藏）；正常倾听时主麦在用，不开它，免得抢同一支麦。
function startKnockListener() {
  if (!KNOCK_ENABLED || knockMic) return;
  if (sessionActive && !panelHidden) return;   // 正在倾听 → 主麦占用，不开敲击监听
  knockArmed = true; knockLast = 0;
  knockMic = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', MIC, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  knockMic.stdout.on('data', detectKnock);
  knockMic.stderr.on('data', () => {});
  knockMic.on('exit', () => { knockMic = null; if (KNOCK_ENABLED && (!sessionActive || panelHidden)) setTimeout(() => { if (!knockMic && (!sessionActive || panelHidden)) startKnockListener(); }, 800); });
  console.log('[knock] 敲两下唤醒:监听中');
}
function stopKnockListener() { if (knockMic) { try { knockMic.kill('SIGKILL'); } catch (_) {} knockMic = null; } }

// ───────────────────────── 空闲唤醒调度:唤醒词优先,敲两下兜底 ─────────────────────────
// 唤醒词(voice-wake.js → openWakeWord Python 边车,默认关,需 COACH_WAKE=1)和敲两下都抢同一支麦,
// 不能同时跑。开了唤醒词且边车起得来 → 喊词唤醒;没开/起不来 → 退回「敲两下」。都只在无会话时运行。
let voiceWake = null;
function getVoiceWake() {
  if (voiceWake) return voiceWake;
  try {
    voiceWake = createVoiceWake({
      onDown: () => { if (!sessionActive || panelHidden) startKnockListener(); },  // 边车挂了 → 回退敲两下
    });
    voiceWake.setEnabled(WAKE_ENABLED);   // 与运行时开关同步
  } catch (_) { voiceWake = { start: () => false, stop: () => {}, restart: () => false, setEnabled: () => {}, isEnabled: () => false }; }
  return voiceWake;
}
// 敲醒 / 喊醒 → 直接进【录音】态：强制清掉暂停和「上轮打字」，让 resumeListen 开麦倾听，
// 不要给灰色 type-only。（双击显示不走这里，仍保留暂停粘性。）
function wakeToRecording(conf = 1, rms = 0) {
  const now = Date.now();
  if (now - lastWakeAt < WAKE_COOLDOWN_MS) { console.log('[wake] 冷却中(' + (now - lastWakeAt) + 'ms) → 忽略重复触发'); return; }
  lastWakeAt = now;
  if (speaking) {   // 它在说话/思考 → 打断不再靠喊词(改由主麦音量监听 bargeWatch:你一开口就打断)。这里忽略喊词,避免它念到"claude"自触发。
    console.log('[wake] 说话中收到喊词 → 忽略(打断已改为:你开口说话即打断)');
    return;
  }
  const wasPaused = paused;
  paused = false; lastTyped = false;   // 清掉暂停/上轮打字 → resumeListen 会开麦倾听（不是灰 type-only）
  if (inMini) { wokeFromMini = true; inMini = false; petControl({ mini: false }); }   // 从 mini 喊出来 → 让 clawd 先缩放出来(说完空闲会缩回去)
  sayPet('', ST_HAPPY, 'clawd-wake.svg', 1300);   // 喊到了 → 桌宠先"跳出来"反应一下,再起/显示会话
  if (!sessionActive) { console.log('[wake] 唤醒 → 起会话(录音)'); startSession(); }
  else if (panelHidden) { console.log('[wake] 唤醒 → 显示会话 + 录音'); showPanel(); }
  // 显示着、没隐藏:暂停中 或 正在打字预备(点了输入框、/mic-off 关了麦、forwarding=false)→ 喊 Claude 立刻转为录音说话(说完照常发送)。
  else if (wasPaused || !forwarding) { console.log('[wake] 已显示但没在录音(暂停/打字预备)→ 喊 Claude 切回录音'); resumeListen(); }
}
// 喊词打断:开(默认)→ 唤醒边车在会话期间也常驻,Claude 说话时喊 Claude 能打断(wakeToRecording→doBarge)。
// 代价:边车和主麦(Scribe)同时占麦;macOS 一般允许共享,若开了之后发现"说话听不见了"(主麦抢不到),
// 就在 .env 设 COACH_WAKE_BARGE=0 关掉(那样只在空闲/隐藏时听唤醒,说话时不能喊断)。
const WAKE_BARGE = process.env.COACH_WAKE_BARGE !== '0';
// 语音打断总开关:默认开。它说话/思考时你一开口就掐掉它、轮到你说。不想要(只留单击)→ COACH_BARGE_VOICE=0。
let BARGE_VOICE = process.env.COACH_BARGE_VOICE !== '0';
// 打断判据=你主麦的音量(归一化 RMS 0..1),不再靠喊"Claude"(长篇 TTS 会盖住你、且它念到 claude 会自触发)。
// 你说话超过这个门槛、且连续 BARGE_SUSTAIN_MS 毫秒 → 打断。外放回声会垫高底噪:自打断就调高门槛,打不断就调低。
let BARGE_RMS = Number(process.env.COACH_BARGE_RMS || 0.06);
let BARGE_SUSTAIN_MS = Number(process.env.COACH_BARGE_SUSTAIN_MS || 110);
// 它"干活/思考中"(还在跑工具、没开口念回复)时打断要更难:持续说话门槛 ×这个倍数,且触发=真 ESC 中断(停掉 agent 的活)。
const BARGE_WORK_MULT = Number(process.env.COACH_BARGE_WORK_MULT || 2);
// 喊词唤醒开关 + 命中阈值(设置页可调;阈值改后重拉边车生效)。
let WAKE_ENABLED = process.env.COACH_WAKE === '1';
let WAKE_THRESHOLD = Number(process.env.COACH_WAKE_THRESHOLD || 0.65);
// 唤醒冷却:多个边车/连续命中时,这段时间内的重复 /wake 全忽略,防"一喊连触发两三次"(动画头几帧重播+多个音效叠放)。
let lastWakeAt = 0;
const WAKE_COOLDOWN_MS = Number(process.env.COACH_WAKE_COOLDOWN_MS || 1500);
let _bargeBytes = 0;   // 连续超过门槛的累计字节(16k 单声道 s16le:每毫秒 32 字节);中断即清零,必须"持续"才算你真在说
function bargeWatch(chunk) {   // 在它说话/干活期间被主麦数据回调调用
  if (!BARGE_VOICE || !speaking) return;
  const working = pending != null;                         // 还在等大脑(跑工具/思考)= 干活;否则 = 正在念回复(TTS)
  const need = BARGE_SUSTAIN_MS * (working ? BARGE_WORK_MULT : 1);   // 干活时要持续更久才打断,防误中断
  if (pcmRms(chunk) >= BARGE_RMS) {
    _bargeBytes += chunk.length;
    if (_bargeBytes >= need * 32) {
      _bargeBytes = 0;
      if (working) { console.log('[barge] 干活中你持续说话 → 真 ESC 中断 agent'); interruptBrain(); }
      else { console.log('[barge] 说话中你开口了 → 打断,轮到你说'); doBarge(); }
    }
  } else { _bargeBytes = 0; }
}
// 真打断(等价 Claude Code 里按 ESC):给常驻 claude 发 stream-json 控制请求 interrupt,停掉它当前那一轮的活;
// 同时本地按打断收尾(惊吓动画 + 立刻把回合还给你)。半截工具流由 CLI 自己停,之后大脑仍可接着用。
function interruptBrain() {
  turnAborted = true; ttsAborted = true; _bargeBytes = 0;
  if (currentAfplay) { try { currentAfplay.kill('SIGKILL'); } catch (_) {} }   // 掐掉正在播的垫播音
  try {
    if (brainProc && brainProc.stdin && brainProc.stdin.writable) {
      brainProc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int_' + Date.now(), request: { subtype: 'interrupt' } }) + '\n');
    }
  } catch (_) {}
  sayPet('', ST_IDLE, ALERT_ANIM, 900);   // 大感叹号惊吓(同点击打断)
  if (pending) { const p = pending; pending = null; clearTimeout(p.timer); try { p.resolve(''); } catch (_) {} }  // 别再等结果,马上把麦还给你
  console.log('  [barge] 干活中断(ESC)→ 轮到你说');
}
function startIdleWake() { if (getVoiceWake().start()) return; startKnockListener(); }  // 唤醒词没开(false)→ 敲两下
function stopIdleWake() { if (!WAKE_BARGE) getVoiceWake().stop(); stopKnockListener(); }  // 开打断 → 不停语音边车,会话期间也听着

// 暂停录音：关麦、停 TTS、清在途音频，但【仍可打字】（输入框变灰、/text 照发）。粘性，不被显隐重置。
function micPause() {
  if (paused) return;
  paused = true; forwarding = false;
  ttsAborted = true; if (currentAfplay) { try { currentAfplay.kill(); } catch (_) {} }
  stopMic(); resetCapture(); chat({ type: 'level', level: 0 });
  if (!panelHidden) chat({ type: 'lock', on: true });  // 仅置灰（输入框已在，不重发 input，避免入场动画/边框闪一下）
  sayPet('', ST_IDLE); bumpIdle();
  console.log('  [mic] 暂停录音（仍可打字）');
}
function micResume() {
  if (!paused) return;
  paused = false; resetCapture();
  if (!panelHidden && !speaking) { chat({ type: 'lock', on: false }); forwarding = true; startMic(); sayPet('', ST_IDLE, LISTEN_ANIM); chat({ type: 'input' }); bumpIdle(); }
  console.log('  [mic] 恢复录音');
}

// 隐藏会话：面板收起 + 关麦 + 不可打字（不动 paused，保留暂停态）。silent=自动隐藏不出声。
function hidePanel(silent) {
  if (!sessionActive || panelHidden) return;
  panelHidden = true;
  if (!silent) petSound('confirm');
  forwarding = false; ttsAborted = true; if (currentAfplay) { try { currentAfplay.kill(); } catch (_) {} }
  stopMic(); resetCapture(); clearIdle();
  chat({ type: 'hide' }); sayPet('', ST_IDLE);
  startIdleWake();   // 隐藏后开唤醒：喊 Claude 优先(没配则敲两下)→ 重新显示;主麦已停,互不抢
  console.log('  [panel] 隐藏会话（喊 Claude 或敲两下唤回）');
}
// 显示会话：面板出来 + 滚到最底看最新。恢复录音/输入【取决于 paused】——暂停过的仍是灰、不录、可打字。
function showPanel() {
  if (!sessionActive || !panelHidden) return;
  stopIdleWake();   // 先收掉唤醒麦,主麦马上要接管收音
  panelHidden = false; petSound('confirm');
  chat({ type: 'show' });
  resumeListen();   // 按 paused 决定灰/可录；内部发 chat input → 渲染器贴到最底（看得到你最新的气泡）
  console.log('  [panel] 显示会话');
}

// 27 秒无任何输入/录音动作 → 自动隐藏会话（等同双击隐藏，但【不出声】，区别于手动）。有动作就 bump 重置。
const IDLE_HIDE_MS = Number(process.env.COACH_IDLE_HIDE_MS || 27000);
let idleTimer = null;
function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function bumpIdle() {
  clearIdle();
  if (!sessionActive || panelHidden) return;   // 已隐藏就不计时（暂停态仍计时——你还能打字，不打就自动隐藏）
  idleTimer = setTimeout(() => {
    if (!sessionActive || panelHidden) return;
    if (speaking) { bumpIdle(); return; }                // 它正说话不算闲，稍后再判
    console.log('  [idle] 27s 无操作 → 打个哈欠再静默隐藏');
    sayPet('', ST_IDLE, 'clawd-idle-yawn.svg', 1200);    // 困了，先打个哈欠
    setTimeout(() => {
      if (!(sessionActive && !panelHidden && !speaking)) return;
      hidePanel(true);
      if (wokeFromMini) { wokeFromMini = false; petControl({ mini: true }); }   // 从 mini 喊出来的 → 空闲后缩回 mini
    }, 850);
  }, IDLE_HIDE_MS);
}
// ───────────────────────── 设置页:麦克风 + 会话 + 运行时配置 ─────────────────────────
// 列出 avfoundation 音频输入设备(ffmpeg 把设备清单打到 stderr,正常会非零退出)。返回 [{index,name}]。
function listMics() {
  return new Promise((resolve) => {
    let err = '';
    const ff = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', () => resolve([]));
    ff.on('exit', () => {
      const out = []; let inAudio = false;
      for (const line of err.split('\n')) {
        if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
        if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
        if (!inAudio) continue;
        const m = line.match(/\]\s*\[(\d+)\]\s+(.+?)\s*$/);
        if (m) out.push({ index: Number(m[1]), name: m[2].trim() });
      }
      resolve(out);
    });
  });
}
// 切麦克风:device 形如 ":1"(只取音频 index)。换设备 → 重启在用的主麦 / 敲击监听(都用 MIC)。
function applyMic(device) {
  const d = String(device || '').trim();
  if (!d) return false;
  MIC = d.startsWith(':') ? d : (':' + d.replace(/[^0-9]/g, ''));
  const wasRec = !!mic; stopMic();
  if (wasRec) startMic();                                  // 之前在录就接着录(新设备)
  if (knockMic) { stopKnockListener(); startKnockListener(); }
  console.log('  [mic] 切到设备', MIC);
  saveRuntimeConfig();
  return true;
}
// 按 id 重命名任意会话:当前会话走 renameSession;其它会话直接改盘上 json。
function renameSessionById(id, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!id || id === currentSessionId) { renameSession(t); return true; }
  const data = loadSessionData(id); if (!data) return false;
  data.title = t || ((data.messages || []).find((m) => m.role === 'user')?.text || '会话').slice(0, 24);
  try { writeFileSync(sessFile(id), JSON.stringify(data)); } catch (_) { return false; }
  console.log('  [session] 重命名', id, '→', data.title);
  return true;
}
// 删除任意会话:当前会话走 closeSession(删盘+开新空会话);其它会话直接删文件。
function deleteSessionById(id) {
  if (!id) return false;
  if (id === currentSessionId) return closeSession();
  try { rmSync(sessFile(id), { force: true }); } catch (_) { return false; }
  console.log('  [session] 删除', id);
  return true;
}
// 设置页改的偏好落盘,重启自动恢复(只存设备/偏好类,不存 model/mode —— 那俩跟着会话走)。
const CONFIG_FILE = process.env.COACH_CONFIG_FILE || join(homedir(), '.coach-config.json');
function saveRuntimeConfig() {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      mic: MIC, volume: ttsVolume, voiceFx: VOICE_FX,
      bargeVoice: BARGE_VOICE, bargeRms: BARGE_RMS, bargeSustainMs: BARGE_SUSTAIN_MS,
      knock: KNOCK_ENABLED, wake: WAKE_ENABLED, wakeThreshold: WAKE_THRESHOLD,
      musicApp: MUSIC_APP,
    }));
  } catch (_) {}
}
// 启动时把落盘的偏好读回(只赋值,不触发副作用 —— 紧接着的 startIdleWake/startMusicWatch 会用这些值)。
function loadRuntimeConfig() {
  let s; try { s = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return; }
  if (!s || typeof s !== 'object') return;
  if (typeof s.mic === 'string' && s.mic) MIC = s.mic;
  if (Number.isFinite(s.volume)) ttsVolume = Math.max(0, Math.min(1, s.volume));
  if (typeof s.voiceFx === 'boolean') VOICE_FX = s.voiceFx;
  if (typeof s.bargeVoice === 'boolean') BARGE_VOICE = s.bargeVoice;
  if (Number.isFinite(s.bargeRms)) BARGE_RMS = s.bargeRms;
  if (Number.isFinite(s.bargeSustainMs)) BARGE_SUSTAIN_MS = s.bargeSustainMs;
  if (typeof s.knock === 'boolean') KNOCK_ENABLED = s.knock;
  if (typeof s.wake === 'boolean') WAKE_ENABLED = s.wake;
  if (Number.isFinite(s.wakeThreshold)) { WAKE_THRESHOLD = s.wakeThreshold; process.env.COACH_WAKE_THRESHOLD = String(s.wakeThreshold); }
  if (typeof s.musicApp === 'string') MUSIC_APP = s.musicApp;
  console.log('[config] 已恢复偏好:' + CONFIG_FILE);
}
// 当前可调配置快照(给设置页渲染)。
function getConfig() {
  return {
    mic: MIC, model: currentModel, mode: currentMode, scenario: currentScenario,
    volume: ttsVolume, voiceFx: VOICE_FX,
    bargeVoice: BARGE_VOICE, bargeRms: BARGE_RMS, bargeSustainMs: BARGE_SUSTAIN_MS,
    knock: KNOCK_ENABLED, wake: WAKE_ENABLED, wakeThreshold: WAKE_THRESHOLD,
    musicApp: MUSIC_APP,
  };
}
// 应用配置(只动传进来的字段;布尔=开关,数值带范围夹取)。
function applyConfig(c) {
  if (!c || typeof c !== 'object') return getConfig();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  if ('volume' in c) ttsVolume = num(c.volume, 0, 1, ttsVolume);
  if ('voiceFx' in c) VOICE_FX = !!c.voiceFx;
  if ('bargeVoice' in c) BARGE_VOICE = !!c.bargeVoice;
  if ('bargeRms' in c) BARGE_RMS = num(c.bargeRms, 0.01, 0.3, BARGE_RMS);
  if ('bargeSustainMs' in c) BARGE_SUSTAIN_MS = num(c.bargeSustainMs, 30, 1000, BARGE_SUSTAIN_MS);
  if ('model' in c && MODELS.has(c.model)) switchModel(c.model);
  if ('mode' in c && MODES.has(c.mode)) switchMode(c.mode, c.scenario);
  if ('knock' in c) {
    KNOCK_ENABLED = !!c.knock;
    if (!KNOCK_ENABLED) stopKnockListener();
    else if ((!sessionActive || panelHidden) && !getVoiceWake().isEnabled()) startKnockListener();
  }
  if ('wakeThreshold' in c) {
    WAKE_THRESHOLD = num(c.wakeThreshold, 0.3, 0.95, WAKE_THRESHOLD);
    process.env.COACH_WAKE_THRESHOLD = String(WAKE_THRESHOLD);
    if (getVoiceWake().isEnabled()) getVoiceWake().restart();   // 重拉边车让新阈值生效
  }
  if ('wake' in c) {
    WAKE_ENABLED = !!c.wake;
    const vw = getVoiceWake(); vw.setEnabled(WAKE_ENABLED);
    if (WAKE_ENABLED) { stopKnockListener(); vw.start(); }       // 开喊词 → 收掉敲击,起边车
    else { vw.stop(); if (KNOCK_ENABLED && (!sessionActive || panelHidden)) startKnockListener(); }
  }
  if ('musicApp' in c) { MUSIC_APP = String(c.musicApp || '').trim(); startMusicWatch(); }
  console.log('  [config] 更新', JSON.stringify(c));
  saveRuntimeConfig();   // 落盘 → 重启自动恢复
  return getConfig();
}

// ───────────────────────── 音乐联动:配的音乐 App 在放歌 → 桌宠跳律动(headphones-groove);暂停/停 → idle ─────────────────────────
// 收进引擎(常驻,不用手动跑脚本)。仅在桌宠空闲(没在对话)时联动,不抢会话动画。
// 判定:配的 App 在跑 且 nowplaying-cli 的 playbackRate>0(暂停=0);没装 nowplaying-cli 则退回"App 在跑就当在放"。
let MUSIC_APP = process.env.COACH_MUSIC_APP || '';   // pgrep -if 模式;'' = 关闭
let musicTimer = null, musicGrooving = false, musicLastGroove = 0;
const MUSIC_GROOVE_ANIM = process.env.COACH_MUSIC_ANIM || 'clawd-headphones-groove.svg';
// 停律动:不能靠 setState(idle)(同值会被 state.js 去重、不触发 cancelReaction),改用一个短的中性动画把
// 律动顶掉、随即自然结束回到 idle。
const MUSIC_STOP_ANIM = process.env.COACH_MUSIC_STOP_ANIM || 'clawd-idle-look.svg';
function _runCmd(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args); let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(null));
      p.on('exit', (code) => resolve({ code, out: out.trim() }));
    } catch (_) { resolve(null); }
  });
}
async function musicIsPlaying() {
  if (!MUSIC_APP) return false;
  const pg = await _runCmd('pgrep', ['-if', MUSIC_APP]);
  if (!pg || pg.code !== 0 || !pg.out) return false;          // App 没开
  const np = await _runCmd('nowplaying-cli', ['get', 'playbackRate']);
  if (np && np.code === 0 && np.out && np.out !== 'null') {
    const n = parseFloat(np.out);
    if (Number.isFinite(n)) return n > 0;                     // 有 playbackRate → 以它为准(暂停=0)
  }
  return true;                                                // 没装 nowplaying-cli → App 开着就当在放
}
async function musicTick() {
  if (!MUSIC_APP) return;
  const idle = !speaking && (!sessionActive || panelHidden);  // 仅空闲态联动,不抢会话动画
  const playing = idle && await musicIsPlaying();
  const now = Date.now();
  if (playing) {
    if (!musicGrooving || now - musicLastGroove >= 12000) {    // 起跳 + 12s keepalive(防被别的状态切走)
      sayPet('', ST_IDLE, MUSIC_GROOVE_ANIM, 600000); musicLastGroove = now;
      if (!musicGrooving) console.log('[music] 在放歌 → 律动');
    }
    musicGrooving = true;
  } else {
    if (musicGrooving && idle) { sayPet('', ST_IDLE, MUSIC_STOP_ANIM, 350); console.log('[music] 暂停/停 → idle'); }   // 短动画顶掉律动→回 idle;会话期(idle=false)不动它
    musicGrooving = false;
  }
}
function startMusicWatch() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  if (musicGrooving) { sayPet('', ST_IDLE); musicGrooving = false; }
  if (MUSIC_APP) { musicTimer = setInterval(musicTick, 4000); console.log('[music] 联动开启:' + MUSIC_APP); }
}

const controlServer = http.createServer((req, res) => {
  // ── 设置页:GET 读配置 / 麦克风列表 ──
  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: getConfig(), current: currentSessionId, sessions: listSessions(50) }));
    return;
  }
  if (req.method === 'GET' && req.url === '/memory') {   // 读当前记忆档案（名字 + 事实），给设置页/菜单展示用
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, profile: loadProfile() }));
    return;
  }
  if (req.method === 'GET' && req.url === '/mics') {
    listMics().then((mics) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, mics, current: MIC })); });
    return;
  }
  if (req.method === 'POST' && req.url === '/text') {           // 打字输入（聊天栏回车）+ 可选粘贴的图片
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 12_000_000) req.destroy(); });   // 放大上限:图片 base64 可能几 MB
    req.on('end', () => {
      let t = '', imgs = [];
      try { const j = JSON.parse(b || '{}'); t = j.text || ''; if (Array.isArray(j.images)) imgs = j.images; else if (j.image) imgs = [j.image]; } catch (_) {}
      pendingImages = [];
      for (const u of imgs) {   // data URL: data:image/png;base64,xxxx
        const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(u || ''));
        if (m) pendingImages.push({ media_type: m[1], data: m[2] });
      }
      console.log('[text] 收到 text=' + t.length + '字 images=' + pendingImages.length + ' | state sessionActive=' + sessionActive + ' speaking=' + speaking + ' panelHidden=' + panelHidden + ' paused=' + paused);
      // 是否会被处理(打字态:panelHidden 会自愈,故不计入丢弃条件)。渲染端据此决定是否清空输入,避免"打了字没发出去还消失"。
      const willProcess = sessionActive && !speaking && (pendingImages.length > 0 || String(t).trim().length > 1);
      if (t || pendingImages.length) { bumpIdle(); handleUtterance(String(t)); }   // 打字/图片 = 有操作，重置闲置计时
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, accepted: willProcess }));
    });
    return;
  }
  if (req.method === 'POST' && (req.url === '/sessions' || req.url === '/session/new' || req.url === '/session/close')) {  // 列会话 / 新建 / 关闭（右键菜单用）
    if (req.url === '/session/new') newSession();
    else if (req.url === '/session/close') closeSession();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, current: currentSessionId, sessions: listSessions() }));
    return;
  }
  if (req.method === 'POST' && req.url === '/session/switch') {                     // 切到某历史会话
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on('end', () => {
      let id = ''; try { id = JSON.parse(b || '{}').id || ''; } catch (_) {}
      const okk = id ? switchSession(id) : false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: okk, current: currentSessionId, sessions: listSessions() }));
    });
    return;
  }
  if (req.method === 'POST' && (req.url === '/session/rename' || req.url === '/session/delete')) {  // 设置页:改名 / 删除任意会话
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch (_) {}
      const okk = req.url === '/session/rename' ? renameSessionById(j.id, j.title) : deleteSessionById(j.id);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !!okk, current: currentSessionId, sessions: listSessions(50) }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/config') {                            // 设置页:批量改运行时配置
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch (_) {}
      const cfg = applyConfig(j);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: cfg }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/mic') {                               // 设置页:切麦克风
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1024) req.destroy(); });
    req.on('end', () => {
      let d = ''; try { d = JSON.parse(b || '{}').device || ''; } catch (_) {}
      const okk = applyMic(d);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: okk, mic: MIC }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/volume') {                            // 右键菜单调音量
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1024) req.destroy(); });
    req.on('end', () => {
      try { const j = JSON.parse(b || '{}'); if (typeof j.level === 'number') ttsVolume = Math.max(0, Math.min(2, j.level)); } catch (_) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, volume: ttsVolume }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/mini') {                              // clawd 进/出 mini 时通知:进 mini → 自动隐藏会话
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1024) req.destroy(); });
    req.on('end', () => {
      let on = false; try { on = !!JSON.parse(b || '{}').on; } catch (_) {}
      inMini = on;
      if (on && sessionActive && !panelHidden) hidePanel(true);   // 切到 mini(贴边)→ 隐藏会话
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, inMini }));
    });
    return;
  }
  if (req.method === 'POST' && (req.url === '/model' || req.url === '/mode')) {   // 外部切模型/模式（热键可调）
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(b || '{}'); } catch (_) {}
      let ack = '';
      if (req.url === '/model' && MODELS.has(body.model)) ack = switchModel(body.model);
      else if (req.url === '/mode' && MODES.has(body.mode)) ack = switchMode(body.mode, body.scenario);
      else ack = '参数无效';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ack, mode: currentMode, model: currentModel, scenario: currentScenario }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/wake') {                              // 喊词唤醒(带置信度)→ 起/显示/打断
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1024) req.destroy(); });
    req.on('end', () => {
      let conf = 1, rms = 0; try { const j = JSON.parse(b || '{}'); if (typeof j.confidence === 'number') conf = j.confidence; if (typeof j.rms === 'number') rms = j.rms; } catch (_) {}
      wakeToRecording(conf, rms);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === 'POST') {
    if (req.url === '/toggle-session') {  // 双击：没开→起会话；以「面板是否隐藏」为准来回切（显示/隐藏与录音锁同步）
      if (!sessionActive) startSession();
      else if (panelHidden) showPanel();   // 显示 + 恢复录音/输入
      else hidePanel();                     // 隐藏 + 暂停录音/禁输入
    }
    else if (req.url === '/start') startSession();
    else if (req.url === '/stop') stopSession();
    else if (req.url === '/pause') micPause();             // 暂停录音（仍可打字）
    else if (req.url === '/resume') micResume();
    else if (req.url === '/toggle') (paused ? micResume() : micPause());   // 输入框 ⏸ 按钮：切暂停录音
    else if (req.url === '/poke') doBarge();   // 点击桌宠：它在说话就打断、轮到你说（否则忽略）
    // 打字聚焦时停麦（区别于 micPause 的粘性暂停；失焦 /mic-on 恢复）
    else if (req.url === '/mic-off') { bumpIdle(); forwarding = false; stopMic(); resetCapture(); chat({ type: 'level', level: 0 }); }
    else if (req.url === '/mic-on')  { bumpIdle(); if (sessionActive && !paused && !panelHidden && !speaking) { forwarding = true; startMic(); } }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessionActive, paused, panelHidden, speaking, mode: currentMode, model: currentModel, scenario: currentScenario }));
});
controlServer.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n  [error] 控制端口 ${CONTROL_PORT} 已被占用 —— 多半还有个旧引擎在跑。`);
    console.error(`    先收掉它：  lsof -ti tcp:${CONTROL_PORT} | xargs kill -9   然后重跑。\n`);
  } else {
    console.error('  [error] 控制端口出错：', e && e.message || e);
  }
  process.exit(1);   // 干净退出，不甩 stack trace
});
controlServer.listen(CONTROL_PORT, '127.0.0.1', () => console.log(`[control] 控制端口 http://127.0.0.1:${CONTROL_PORT}  (/toggle /poke /model /mode /sessions /session/new /session/switch)`));

// ───────────────────────── 启动 / 退出 ─────────────────────────
bootSession();   // 接上次会话（有记录就 resume），否则全新开
startWhisperServer();   // STT=local → 拉起常驻 whisper-server（模型只加载一次）
console.log(STT === 'local' ? `[stt] 本机 whisper-server（${WHISPER_MODEL.split('/').pop()}，离线）` : '[stt] ElevenLabs Scribe（云端兜底）');
// boot 是空闲态(无会话):不空跑 Scribe 麦,改进入空闲唤醒(声纹优先,敲两下兜底)。
// 会话一开 startSession() 会 stopIdleWake() 并由 resumeListen() 接管 Scribe 麦。
// 先清掉上一轮引擎被 kill -9 后遗留的孤儿唤醒边车(否则多个边车同时上报 /wake → 一喊连触发两三次)。
loadRuntimeConfig();              // 先恢复落盘的偏好(麦克风/音量/打断/唤醒/音乐 App),下面的 watcher 就用这些值
try { spawn('pkill', ['-f', 'wake-listener.py']).on('error', () => {}); } catch (_) {}
setTimeout(startIdleWake, 400);   // 等孤儿被收掉再起自己的边车
startMusicWatch();                // 音乐联动(配了 App 才起;设置页/落盘的选择会被 loadRuntimeConfig 恢复)

function shutdown() {
  console.log('\n  收尾…');
  try { if (mic) mic.kill('SIGKILL'); } catch (_) {}
  try { if (currentAfplay) currentAfplay.kill(); } catch (_) {}
  try { if (whisperProc) whisperProc.kill('SIGKILL'); } catch (_) {}   // 收掉常驻 whisper-server
  try { getVoiceWake().stop(); } catch (_) {}                          // 收掉唤醒边车,别留孤儿
  try { stopKnockListener(); } catch (_) {}
  try { if (musicTimer) clearInterval(musicTimer); } catch (_) {}
  killBrain();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
