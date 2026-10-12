# crossfade overlap-stacking template
# Usage:
#   1. Put trimmed WAVs in work_dir as seg1.wav, seg2.wav, ...
#   2. Edit WORK_DIR and FILES below
#   3. python crossfade.py
#   4. Convert: ffmpeg -i crossfade_full.wav -codec:a libmp3lame -b:a 192k out.mp3
import wave, struct, os, math
import numpy as np

# ====== User config ======
WORK_DIR = r"."
FILES = ["seg1.wav", "seg2.wav", "seg3.wav"]
OUTPUT = "crossfade_full.wav"
OVERLAP = 2.0
FADE_IN = 2.0
FADE_OUT = 2.0
TARGET_RMS = 0.12
# ==========================

def read_wav(path):
    w = wave.open(path, 'rb')
    nch = w.getnchannels(); sw = w.getsampwidth(); fr = w.getframerate(); nf = w.getnframes()
    raw = w.readframes(nf); w.close()
    assert sw == 2, "Need 16-bit PCM WAV"
    samples = np.array(struct.unpack("<" + "h" * nch * nf, raw), dtype=np.float64) / 32768.0
    return fr, nch, samples

def write_wav(path, fr, nch, samples):
    w = wave.open(path, 'wb')
    w.setnchannels(nch); w.setsampwidth(2); w.setframerate(fr)
    s16 = np.clip(samples * 32768.0, -32768, 32767).astype(np.int16)
    w.writeframes(s16.tobytes()); w.close()

def eq_power(p, direction):
    t = max(0.0, min(1.0, p)) * math.pi / 2.0
    return math.sin(t) if direction == 'in' else math.cos(t)

segs = [read_wav(os.path.join(WORK_DIR, f)) for f in FILES]
fr0, nch0 = segs[0][0], segs[0][1]
overlap_frames = int(OVERLAP * fr0)
lens = [len(s) // nch0 for _, _, s in segs]
print(f"Segment lengths (s): {[l/fr0 for l in lens]}")

norm = []
for i, (fr, nch, samples) in enumerate(segs):
    rms = float(np.sqrt(np.mean(samples**2)))
    scale = min(TARGET_RMS / max(rms, 1e-6), 3.0)
    norm.append(samples * scale)
    print(f"seg{i+1} RMS: {rms:.4f} -> {rms*scale:.4f}")

starts = [0]
for i in range(1, len(norm)):
    starts.append(starts[-1] + lens[i-1] - overlap_frames)
total_frames = starts[-1] + lens[-1]
print(f"Total: {total_frames/fr0:.2f}s")

out = np.zeros(total_frames * nch0, dtype=np.float64)

def mix_in(seg, start_frame, fin_s=0, fout_s=0):
    slen = len(seg) // nch0
    fin = int(fin_s * fr0) if fin_s > 0 else 0
    fout = int(fout_s * fr0) if fout_s > 0 else 0
    for i in range(slen):
        g = 1.0
        if fin and i < fin:
            g *= eq_power(i / fin, 'in')
        if fout and i >= slen - fout:
            g *= eq_power((slen - i) / fout, 'out')
        if g <= 0.001:
            continue
        for c in range(nch0):
            out[(start_frame + i) * nch0 + c] += seg[i * nch0 + c] * g

mix_in(norm[0], starts[0], FADE_IN, OVERLAP)
for i in range(1, len(norm)-1):
    mix_in(norm[i], starts[i], OVERLAP, OVERLAP)
mix_in(norm[-1], starts[-1], OVERLAP, FADE_OUT)

peak = float(np.max(np.abs(out)))
print(f"peak: {peak:.4f}")
if peak > 0.95:
    out *= 0.95 / peak

write_wav(os.path.join(WORK_DIR, OUTPUT), fr0, nch0, out)
print("done")
