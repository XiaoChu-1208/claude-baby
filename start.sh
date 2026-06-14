#!/usr/bin/env bash
# Claude Baby — start both the desktop pet and the engine in the background.
# Nothing stays attached to your terminal; closing the window won't stop them.
#
# Logs:  /tmp/coach-engine.log (engine)   /tmp/clawd-pet.log (pet)
# Stop:  pkill -f coach-engine.js && pkill -9 -f "clawd-on-desk/node_modules/electron"
#
# Paths are derived from this script's location. The pet (clawd-on-desk) is
# expected as a sibling folder; override with CLAWD_PET_DIR if it lives elsewhere.

COACH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PET="${CLAWD_PET_DIR:-$(cd "$COACH/.." && pwd)/clawd-on-desk}"
PORT="${COACH_CONTROL_PORT:-23390}"

if [ ! -d "$PET" ]; then
  echo "Error: pet app not found at $PET"
  echo "Clone it next to this folder:  git clone https://github.com/XiaoChu-1208/clawd-on-desk.git"
  echo "or set CLAWD_PET_DIR to its path."
  exit 1
fi

# Force-release the control port: SIGTERM the old engine, then -9 as a fallback,
# polling until the port is actually free.
free_port() {
  pkill -f coach-engine.js 2>/dev/null
  local pids; pids=$(lsof -ti tcp:"$PORT" 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for i in $(seq 1 20); do
    pids=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    [ -z "$pids" ] && return 0
    sleep 0.25
    pids=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  [ -z "$(lsof -ti tcp:"$PORT" 2>/dev/null)" ]
}

echo "==> Stopping any old instances..."
pkill -9 -f "clawd-on-desk/node_modules/electron" 2>/dev/null
pkill -f "wake-listener.py" 2>/dev/null   # kill orphaned wake-word sidecars from a previous run
free_port || { echo "Error: port $PORT won't free up; inspect with: lsof -nP -iTCP:$PORT"; exit 1; }
sleep 1

echo "==> Starting the pet (background)..."
( cd "$PET" && CLAWD_COACH_MODE=1 nohup npm start >/tmp/clawd-pet.log 2>&1 & )

# Give the pet time to come up (first run asks for mic permission -> click Allow).
sleep 6
free_port   # in case a click on the pet spawned an engine in those 6s

echo "==> Starting the engine (background)..."
( cd "$COACH" && nohup node coach-engine.js >/tmp/coach-engine.log 2>&1 & )

echo "Started in the background."
echo "  Logs: /tmp/coach-engine.log   /tmp/clawd-pet.log"
echo "  Stop: pkill -f coach-engine.js && pkill -9 -f \"clawd-on-desk/node_modules/electron\""
