#!/usr/bin/env python3
# enroll_claude.py — 录 4 遍 "Claude" → 生成唤醒模型 claude_ref.json
# (EfficientWord-Net 少样本:不训练、不联网、不碰 Colab。最少 4 个样本。)
#
# 跑:  cd ~/Desktop/同步/english-speaking-coach && python3 enroll_claude.py
# 第一次会弹"允许麦克风",点允许。每遍按回车 → 倒数 → 清楚说一声 "Claude"。
import os
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SAMP = os.path.join(HERE, "claude_samples")
os.makedirs(SAMP, exist_ok=True)
SR, SECS, N = 16000, 1.5, 4   # 16kHz 单声道,每遍 1.5s,共 4 遍(库要求 >=4)

try:
    import sounddevice as sd
    from eff_word_net.generate_reference import generate_reference_file
    from eff_word_net.audio_processing import ModelType
except Exception as e:  # noqa: BLE001
    print("缺依赖:", e)
    sys.exit(1)


def record(path):
    for c in ("3", "2", "1", "说 Claude!"):
        print("    " + c, flush=True)
        time.sleep(0.6)
    audio = sd.rec(int(SR * SECS), samplerate=SR, channels=1, dtype="int16")
    sd.wait()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(audio.tobytes())
    print("    已录 ->", os.path.basename(path), flush=True)


print("== 录 4 遍 'Claude'(自然、正常音量)==", flush=True)
for i in range(1, N + 1):
    input("\n第 %d/%d 遍,按回车开始录:" % (i, N))
    record(os.path.join(SAMP, "claude_%d.wav" % i))

print("\n生成唤醒模型中...", flush=True)
generate_reference_file(
    input_dir=SAMP,
    output_dir=HERE,
    wakeword="claude",
    model_type=ModelType.resnet_50_arc,
    debug=False,
)
ref = os.path.join(HERE, "claude_ref.json")
ok = os.path.exists(ref)
print("\n完成! 模型:" if ok else "\n失败,未生成:", ref, flush=True)
print("接下来:重启引擎(或单独跑 wake-listener.py),喊 'Claude' 试试。" if ok else "把上面的报错发我。", flush=True)
