# Speaking Coach — 自用英语口语陪练

打开网页，麦克风常开：你说话它静音倾听、你说完它才用语音回你，像真人来回。专练公司英语考试的商务场景（alignment / 季度目标取舍 / 站会 / roadmap）。

- **听你说（STT）**：浏览器自带 Web Speech API（en-US，免费、瞬时）
- **大脑**：Claude（默认 Haiku 求快，界面可切 Sonnet 求质量），系统提示=商务英语陪练，回复 1–3 句
  - 默认 `BRAIN=claudecode`：本地服务 spawn 你已登录的 `claude` CLI（无头模式），**吃 Claude 订阅、不花 API credits**。前提：本机装了 Claude Code 且已登录。
  - `BRAIN=api`：直连 Anthropic API（吃 API 钱包，需 console 充值）。充值后想切回再用。
- **念给你听（TTS）**：ElevenLabs Flash（低延迟、省一半 credit），流式边到边播
- **本地薄服务**：`server.js` 托管网页 + 藏两个 key + 转发 + 出站走代理

## 跑起来（一条命令）

```bash
cd ~/Desktop/同步/english-speaking-coach && npm start
```

`npm start` 会**起服务 + 自动开 Chrome** 到 `http://localhost:5178`。第一次先 `npm install`。
（不想自动开浏览器：`OPEN=0 npm start`。）

聊天走**常驻的 `claude` 进程**：点开始/切场景时开一次、整段对话复用它、自己记上下文，所以每轮不再冷启动。只有切场景或切 Haiku/Sonnet 时会重开一次（那是没办法，模型/系统提示在开进程时定死）。

## 配置（默认走订阅，省心）

1. **大脑** — 默认 `BRAIN=claudecode`，**不需要 Anthropic key**，只要本机 Claude Code 已登录即可（就是你平时用的那个订阅）。
   - ELEVENLABS_API_KEY 已填好（语音那段）。
   - 充值了想切 API 直连：`.env` 改 `BRAIN=api` 并填 `ANTHROPIC_API_KEY`。
2. **HTTPS_PROXY** — 北京/墙内必填。STT(Google) + ElevenLabs 在墙外（聊天走本机 claude，它自己会用系统代理）：
   - 本地服务出站走代理 → `.env` 填 `HTTPS_PROXY=http://127.0.0.1:7890`（换成你 Clash/Verge 的 http 口）。**你 shell 若已 export 代理，会自动认到，可不填。**
   - **浏览器本身也要在代理下**，否则 Web Speech 连不上 Google。跟手感取决于代理质量，不是代码问题。

> 注意：claudecode 模式下，本地服务 spawn `claude` 时**特意删掉了子进程里的 `ANTHROPIC_API_KEY`**——否则 CLI 会优先用那个 key（空 API 钱包）而不走订阅。所以 `.env` 里就算填了 key，claudecode 模式也不会用它。

## 用法

- 进页面点「按一下开始」（这一下手势同时解锁麦克风和自动播放）。
- 顶部选场景：自由聊 / Alignment / 季度目标 / 站会 / Roadmap —— 切换即清空重开，AI 先开场白。
- 直接说英语就行；停顿约 1 秒它就当你说完、开始回。
- **它说话时你一开口就能打断**（barge-in）。**空格键**=手动兜底：AI 说话时按它闭嘴、你说话时按立刻发送。
- 右上角可切 **Haiku/Sonnet** 和 **暖色/暗色**。

## 几个旋钮（在 `public/index.html` 顶部）

- `SILENCE_MS`（默认 1100）：说完判定的静默时长，嫌它抢话就调大。
- `BARGE_GATE`（默认 0.045）：插话的麦音量门，外放误触发就调大、戴耳机可调小。
- 音色/语速：`server.js` 里 `VOICE_ID` 和 `voice_settings`。

## 耳机 vs 外放

- **戴耳机**：物理断回环，常开+打断最丝滑，**推荐**。
- **外放**：已开浏览器 AEC（回声消除）+ 音量门控挡回声，能用但偶尔会把 AI 的话当成你的。真要硬刚外放，把 STT 挪到本地服务用 Whisper/ElevenLabs 转写（后路，先不做）。

## 安全

- 两个 key 只在 `.env`（`.gitignore` 已排除），绝不进 HTML/仓库。
- 换 key 后记得同步 `.env`。

## 桌宠引擎：首次安装的前置动作（必读）

桌宠引擎（`coach-engine.js`，语音驱动的通用 Claude 助手）是这个项目现在的主体。装它要先备齐下面这些——**前四项必装,缺了起不来**：

**必需**
1. **Node ≥ 18.17** —— 然后 `npm install`。
2. **Claude Code CLI，已安装且已登录订阅** —— 引擎的「大脑」。它会 spawn 你本机的 `claude` 进程、并**特意删掉子进程里的 `ANTHROPIC_API_KEY`**，强制走你的订阅 OAuth（不花 API credits）。先确认终端里 `claude` 能跑、已登录。
3. **ffmpeg** —— 抓麦克风 + 语音电话失真。`brew install ffmpeg`。
4. **ElevenLabs API key** —— 复制 `.env.example` 为 `.env`，填 `ELEVENLABS_API_KEY`（发声用；STT 云端兜底 Scribe 也用它）。
5. **clawd-on-desk（桌宠本体）跑起来，且开 `CLAWD_COACH_MODE`** —— 它是「身体/脸」，引擎是「大脑」，两者走本地端口对接。
6. **macOS 麦克风权限** —— 给运行引擎的终端授权（系统设置 → 隐私 → 麦克风）。

**可选（增强，不装也能跑）**
7. **本机离线 STT（推荐：免云、免 key、更快）** —— `brew install whisper-cpp`，把模型 `ggml-large-v3-turbo.bin` 下到 `~/.whisper-models/`，`.env` 设 `COACH_STT=local`。不装则自动走 ElevenLabs Scribe（用上面那把 key）。
8. **喊词唤醒「Claude」** —— `brew install portaudio` → `pip3 install -r requirements-wake.txt` → 录声纹 `python3 enroll_claude.py`（喊 4 遍 Claude，生成 `claude_ref.json`）→ `.env` 设 `COACH_WAKE=1`。不装则没有喊词唤醒（仍可双击/单击操作）。
9. **垫播音（等待时的「嗯/让我想想」）** —— `node generate-acks.js` 生成（用 ElevenLabs key + ffmpeg；跟 `ELEVENLABS_VOICE_ID` 绑定）。不生成则等待时静默，无影响。
10. **出站代理（墙内）** —— `.env` 的 `HTTPS_PROXY` 填 Clash/Verge 的 http 口。

**起引擎**：`./start.sh`（或 `node coach-engine.js`）。

> 注意：仓库**不含** `.env`（key）、`claude_ref.json`/`claude_samples/`（你的声纹/录音）、`acks/`（生成的音频）——这些都按 `.gitignore` 排除，每台机器各自生成。

## 桌宠引擎 `coach-engine.js`：通用助手 + 英语陪练（语音）

桌宠那条链路（`./start.sh` 拉起的）不再只是英语陪练，而是一个**语音驱动的通用 Claude Code 助手**。两种模式：

- **`agent`（默认）**——能解答各种问题、也**能真干活**：开全工具、自动批准（headless）、在工作目录里跑 bash / 读写文件 / 搜索 / 用 skills。完整答案（含代码、路径、命令）进**桌宠聊天栏**；TTS 只念**一句口语小结**（长答案自动剥掉代码/markdown，太长就念前两句 + “完整内容在聊天栏”）。干活时摆 `working` 打字动画，桌宠气泡里闪当前状态（`Claude is searching…` / `coding…` / `running commands…`），**不**往聊天栏灌工具历史。
- **`coach`**——原来的英语陪练（关工具、强制 1–2 句、商务场景），`/coach`、`/coach alignment` 等进入。

**切模型（对话里，斜杠或自然语言都行）**——默认 `haiku` 求快，随时切 `sonnet`/`opus`：
- 斜杠：`/model opus`、`/model sonnet`、`/model haiku`（也认 `/opus`）
- 自然语言：「用 opus」「切到 sonnet」「换成 haiku」「opus。」
- 切模型用 `--resume` **保留上下文**（接着上一句继续聊，不重开）。

**切模式**：`/agent`、`/coach`；或说「英语陪练」「回到助手」。切模式会**重置上下文**（系统提示变了）。

**工作目录**：agent 默认在 `~/Desktop/同步` 里干活，改 `.env` 的 `COACH_WORKDIR`。
**默认模式/模型**：`.env` 的 `COACH_MODE` / `COACH_MODEL`。
**外部切换**：控制端口（默认 23390）也收 `POST /model {"model":"opus"}`、`POST /mode {"mode":"coach","scenario":"free"}`，可绑桌宠热键。

> 注意：agent 模式开了 `--permission-mode bypassPermissions`：它在工作目录里跑命令、改文件**不会逐个问你**。这是「能干活」的代价，工作目录别指向你不想被动的地方。订阅 OAuth（spawn 时删掉了 API key），不花 API credits。

### 交互动效（桌宠）

- **点击打断**：它正用语音念回复时，**单击桌宠** → 冒一个「!」表情 → 立刻掐掉语音、把回合交给你（唤出聊天栏输入框，可以直接说/打字）。没在说话时点击不打扰它。
  - 实现：桌宠单击 → IPC `coach-poke` → 引擎 `POST /poke`，引擎只在「正在说话」时执行 barge-in（见 `coach-engine.js` 的 `doBarge`、`clawd-on-desk` 的 `hit-renderer.js`/`pet-interaction-ipc.js`/`preload-hit.js`）。
- **work 动画 + 状态闪烁**：agent **调用工具时**摆出 `working` 打字动画，桌宠气泡里闪一句当前在干嘛——`Claude is searching…` / `Claude is coding…` / `Claude is running commands…` / `Claude is browsing the web…` …（**不**把工具历史灌进聊天栏，只闪状态，很 code 味儿）。**切模型/切模式**时也先摆 `working` 动画。
- **更多状态**：开场/欢迎用 `attention`（开心）；出错/超时用 `error`；打断瞬间用 `notification`（「!」）；倾听看着你、说话单跳——状态齐全。可用 `COACH_STATE_*` / `COACH_ALERT_ANIM` 环境变量改映射。
- **声音电话失真**：每段语音过一层 ffmpeg「电话/对讲机」效果（带通 350–3400Hz + 轻 bitcrush + 过载）。默认开，`COACH_VOICE_FX=0` 关、`COACH_VOICE_FX_FILTER` 自定义。需要本机有 `ffmpeg`。

### 手势 / 会话

**双击桌宠**：
- 会话没开 → 起会话（开语音 + 显示对话）。
- 会话开着 → **只隐藏/显示对话面板**，语音不停、麦还在听、它仍能说话；再显示时输入框还在、不重刷记录。
- 真正结束 → **右键菜单 →「结束会话（停语音）」**。

**会话记录持久**（落盘 `~/.coach-sessions/<id>.json`，标题取首句、记 mode/model/对话；`COACH_SESSION_DIR` 改目录）：
- 隐藏对话再显示、`./start.sh` 重启引擎，都能看回上次记录（重启时自动 `--resume` 最近会话接上上下文）。
- **右键菜单**（coach 模式才显示）：**新建会话**（全新上下文 + 清空）/ **切换会话**（子菜单列最近会话，当前的打勾，点一下 `--resume` 切过去并恢复它的记录与 mode/model）/ **结束会话**。
- 实现：菜单/手势 → 引擎 `POST /session/new` `/session/switch` `/sessions` `/stop` `/toggle-session`（见 `coach-engine.js` 会话存储段、`clawd-on-desk/src/menu.js`）。

## 后续可加

- logo + 入场动画（页面左上角已留 `LOGO` 槽位）
- GSAP 替换现在的 Web Animations 文字编排（ui-skills/gsap）
- STT 转本地（外放抗回声终极方案）
