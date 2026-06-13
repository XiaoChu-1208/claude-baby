#!/usr/bin/env python3
# wake-listener.py — 唤醒词边车(EfficientWord-Net 少样本)。听到 "Claude" → POST /start 给引擎。
# 全本地、不调大模型、无 key。需先跑 enroll_claude.py 生成 claude_ref.json。
#
# 由引擎在空闲时自动拉起(.env: COACH_WAKE=1);也可手动:python3 wake-listener.py
# 阈值可调:COACH_WAKE_THRESHOLD(默认 0.65,误唤醒多就调高、叫不醒就调低)。
import os
import sys
import time
import urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("COACH_CONTROL_PORT", "23390"))
REF = os.environ.get("COACH_WAKE_REF", os.path.join(HERE, "claude_ref.json"))
THRESH = float(os.environ.get("COACH_WAKE_THRESHOLD", "0.65"))

if not os.path.exists(REF):
    print("[wake.py] 没找到唤醒模型 %s —— 先跑:python3 enroll_claude.py" % REF, file=sys.stderr)
    sys.exit(1)

try:
    from eff_word_net.streams import SimpleMicStream
    from eff_word_net.engine import HotwordDetector
    from eff_word_net.audio_processing import Resnet50_Arc_loss
except Exception as e:  # noqa: BLE001
    print("[wake.py] 缺依赖: %s" % e, file=sys.stderr)
    sys.exit(1)


def trigger(conf, rms):
    try:
        body = ('{"confidence": %.4f, "rms": %.1f}' % (conf, rms)).encode("utf-8")
        urllib.request.urlopen(
            urllib.request.Request(
                "http://127.0.0.1:%d/wake" % PORT, data=body,
                headers={"content-type": "application/json"}, method="POST"),
            timeout=1.5,
        )
    except Exception:  # noqa: BLE001
        pass


def main():
    model = Resnet50_Arc_loss()
    detector = HotwordDetector(
        hotword="claude",
        model=model,
        reference_file=REF,
        threshold=THRESH,
        relaxation_time=2,
    )
    mic = SimpleMicStream(window_length_secs=1.5, sliding_window_secs=0.75)
    mic.start_stream()
    print("[wake.py] 监听中:喊 Claude(阈值 %.2f)" % THRESH, flush=True)
    last = 0.0
    while True:
        frame = mic.getFrame()
        try:
            result = detector.scoreFrame(frame)
        except Exception:
            continue   # EfficientWord-Net 偶发的"长度盲区"bug → 跳过这一帧,不影响下一帧
        if result is None:
            continue
        if result["match"] and time.time() - last > 2.0:
            last = time.time()
            rms = float(np.sqrt(np.mean(np.square(np.asarray(frame, dtype=np.float64)))))  # 这一帧多响(int16 量级):你对着麦喊≫喇叭漏回来的回声
            print("[wake.py] 命中 Claude(conf=%.2f rms=%.0f) → 上报" % (result["confidence"], rms), flush=True)
            trigger(result["confidence"], rms)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
