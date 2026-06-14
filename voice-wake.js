// voice-wake.js — 唤醒词唤醒(可选,默认关):拉起 openWakeWord 的 Python 边车(wake-listener.py)。
// 边车听到唤醒词 → POST /start 给本引擎。无 key、本地、不卡邮箱。
//
// 开启:在 english-speaking-coach/.env 设 COACH_WAKE=1
//       (并先装好:python3 + pip install openwakeword onnxruntime sounddevice numpy)
// 喊 "Claude":训练一个 openWakeWord 自定义模型,设 COACH_WAKE_MODEL=/路径/claude.onnx;
//             不设则用内置词 "hey_jarvis"。
// 没开 / python 没装 / 边车起不来 → start() 返回 false 或触发 onDown → 引擎回退「敲两下」,绝不崩。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createVoiceWake(opts = {}) {
  const {
    enabled = process.env.COACH_WAKE === '1',          // 默认关:显式开才用唤醒词,否则敲两下
    python = process.env.COACH_PYTHON || 'python3',
    script = path.join(__dirname, 'wake-listener.py'),
    onDown = () => {},                                  // 边车异常退出 → 引擎用它回退到敲两下
    log = console.log,
  } = opts;

  let proc = null, startedAt = 0;
  let on = enabled;                                     // 运行时可改（设置页切换喊词唤醒）

  function setEnabled(v) { on = !!v; }
  function isEnabled() { return on; }

  function start() {
    if (!on) return false;                              // 没开 → 让位给敲两下
    if (proc) return true;
    if (!fs.existsSync(script)) { log('[wake] 缺 wake-listener.py → 回退敲两下'); return false; }
    try {
      startedAt = Date.now();
      proc = spawn(python, [script], { env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'] });
      proc.on('exit', () => {
        const fast = Date.now() - startedAt < 3000;
        proc = null;
        if (fast) { log('[wake] 边车很快退出(可能没装 python/openwakeword)→ 回退敲两下'); try { onDown(); } catch (_) {} }
      });
      log('[wake] openWakeWord 边车已拉起(喊唤醒词唤醒)');
      return true;
    } catch (e) { log('[wake] 拉起边车失败:', e.message, '→ 回退敲两下'); proc = null; return false; }
  }

  function stop() { if (proc) { try { proc.kill('SIGKILL'); } catch (_) {} proc = null; } }
  function restart() { stop(); return start(); }   // 改了阈值(env)后重拉,让新阈值生效

  return { start, stop, restart, setEnabled, isEnabled };
}
