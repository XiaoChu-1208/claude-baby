#!/bin/bash
# 一键拉起英语口语陪练：桌宠 + 引擎，全部后台运行（不占终端，关窗口也不退）。
# 日志：/tmp/coach-engine.log（引擎）/tmp/clawd-pet.log（桌宠）。
# 停止：hello stop  或  pkill -f coach-engine.js && pkill -9 -f clawd-on-desk/.../electron

COACH="$HOME/Desktop/同步/english-speaking-coach"
PET="$HOME/Desktop/同步/clawd-on-desk"
PORT=23390

# 强制释放控制端口：先 SIGTERM 让旧引擎走 shutdown，再 -9 兜底，轮询直到端口真的空了。
free_port() {
  pkill -f coach-engine.js 2>/dev/null
  local pids; pids=$(lsof -ti tcp:$PORT 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for i in $(seq 1 20); do
    pids=$(lsof -ti tcp:$PORT 2>/dev/null)
    [ -z "$pids" ] && return 0
    sleep 0.25
    pids=$(lsof -ti tcp:$PORT 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  [ -z "$(lsof -ti tcp:$PORT 2>/dev/null)" ]
}

echo "▸ 收掉旧的实例…"
pkill -9 -f "clawd-on-desk/node_modules/electron" 2>/dev/null
free_port || { echo "错误：端口 $PORT 始终释放不掉，先手动收掉：lsof -nP -iTCP:$PORT"; exit 1; }
sleep 1

echo "▸ 启动桌宠（后台）…"
( cd "$PET" && CLAWD_COACH_MODE=1 nohup npm start >/tmp/clawd-pet.log 2>&1 & )

# 等桌宠起来（首次会问麦克风权限 → 点允许）
sleep 6
free_port   # 6s 内若有人连点桌宠把引擎 spawn 了，再兜一次底

echo "▸ 启动引擎（后台）…"
( cd "$COACH" && nohup node coach-engine.js >/tmp/coach-engine.log 2>&1 & )

echo "已在后台启动。日志: /tmp/coach-engine.log  /tmp/clawd-pet.log"
echo "  停止: hello stop"
