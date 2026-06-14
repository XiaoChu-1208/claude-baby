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
    from eff_word_net.streams import SimpleMicStream, CustomAudioStream
    from eff_word_net.engine import HotwordDetector
    from eff_word_net.audio_processing import Resnet50_Arc_loss
    from eff_word_net import RATE
except Exception as e:  # noqa: BLE001
    print("[wake.py] 缺依赖: %s" % e, file=sys.stderr)
    sys.exit(1)

# 设备选择:COACH_WAKE_MIC_NAME 指定输入设备名(子串匹配,大小写不敏感)。
# 不设 → 用 PyAudio 默认输入设备(= 系统默认输入,这正是切麦切不动唤醒词的老 bug)。
# 注意:PyAudio 设备索引 ≠ ffmpeg avfoundation 索引,所以必须按名字匹配,不能直接传 index。
WAKE_MIC_NAME = os.environ.get("COACH_WAKE_MIC_NAME", "").strip()


def _norm(s):
    # 归一化设备名以容忍 avfoundation 与 CoreAudio 的命名差异:
    # 剥 ASCII / 中文/弯引号、折叠所有空白、小写。例:「"Chenyang的iPhone"的麦克风」≈「Chenyang的iPhone的麦克风」。
    s = "".join(ch for ch in str(s) if ch not in '"\'`“”‘’「」『』')
    return "".join(s.split()).lower()


def open_mic_stream(window_length_secs, sliding_window_secs):
    """按 COACH_WAKE_MIC_NAME 开 PyAudio 输入流;命名匹配不到 / 没指定 → 退回 SimpleMicStream(默认设备)。"""
    if not WAKE_MIC_NAME:
        return SimpleMicStream(window_length_secs=window_length_secs,
                               sliding_window_secs=sliding_window_secs)
    import pyaudio
    p = pyaudio.PyAudio()
    want = _norm(WAKE_MIC_NAME)
    dev_index, dev_name = None, None
    inputs = []
    for i in range(p.get_device_count()):
        info = p.get_device_info_by_index(i)
        if info.get("maxInputChannels", 0) <= 0:
            continue
        name = str(info.get("name", ""))
        inputs.append((i, name))
    # 先精确(归一化后)等值,再双向子串 —— 名字略有出入也能命中。
    for i, name in inputs:
        if _norm(name) == want:
            dev_index, dev_name = i, name
            break
    if dev_index is None:
        for i, name in inputs:
            n = _norm(name)
            if want and (want in n or n in want):
                dev_index, dev_name = i, name
                break
    if dev_index is None:
        print("[wake.py] 找不到输入设备含「%s」→ 退回默认设备" % WAKE_MIC_NAME, file=sys.stderr)
        p.terminate()
        return SimpleMicStream(window_length_secs=window_length_secs,
                               sliding_window_secs=sliding_window_secs)
    CHUNK = int(sliding_window_secs * RATE)
    stream = p.open(format=pyaudio.paInt16, channels=1, rate=16000, input=True,
                    input_device_index=dev_index, frames_per_buffer=CHUNK)
    stream.stop_stream()
    print("[wake.py] 唤醒麦 → [%d] %s" % (dev_index, dev_name), flush=True)
    return CustomAudioStream(
        open_stream=stream.start_stream,
        close_stream=stream.stop_stream,
        get_next_frame=lambda: np.frombuffer(stream.read(CHUNK, exception_on_overflow=False), dtype=np.int16),
        window_length_secs=window_length_secs,
        sliding_window_secs=sliding_window_secs,
    )


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
    mic = open_mic_stream(window_length_secs=1.5, sliding_window_secs=0.75)
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
