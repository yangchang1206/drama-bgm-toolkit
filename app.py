# -*- coding: utf-8 -*-
"""
Short drama BGM auto-generator web UI.
Flow: paste script -> upload video -> auto segment -> auto search -> crossfade -> MP3
Run: python app.py
"""
import os, re, sys, subprocess, sqlite3, math, wave, struct, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

import gradio as gr


def probe_video_duration(video_path):
    try:
        out = subprocess.check_output([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path
        ], stderr=subprocess.STDOUT, timeout=30)
        return float(out.decode().strip())
    except Exception as e:
        print(f"ffprobe failed: {e}")
        return None


def parse_script_scenes(script_text):
    lines = script_text.split("\n")
    scenes = []
    current = None
    pattern = re.compile(r"(\d{1,3}-\d{1,3})")
    for line in lines:
        m = pattern.search(line)
        if m:
            if current:
                scenes.append(current)
            current = {"id": m.group(1), "text": line}
        else:
            if current:
                current["text"] += "\n" + line
    if current:
        scenes.append(current)
    return scenes


_MODEL = None
_PROCESSOR = None
def get_model():
    global _MODEL, _PROCESSOR
    if _MODEL is None:
        os.environ["HF_ENDPOINT"] = config.HF_ENDPOINT
        import torch
        from transformers import ClapModel, ClapProcessor
        print("Loading CLAP model...")
        _MODEL = ClapModel.from_pretrained(config.CLAP_MODEL).eval()
        _PROCESSOR = ClapProcessor.from_pretrained(config.CLAP_MODEL)
    return _MODEL, _PROCESSOR


def search_music(query, top_n=3, no_vocal=True):
    model, processor = get_model()
    import torch
    inp = processor(text=[query], return_tensors="pt", padding=True)
    with torch.no_grad():
        out = model.get_text_features(**inp)
        te = out.pooler_output.numpy()[0]
        te = te / np.linalg.norm(te)
    conn = sqlite3.connect(config.DB_PATH)
    sql = """SELECT s.id, s.filename, s.fullpath, s.bpm, s.rms, s.duration, e.embed
             FROM songs s JOIN clap_embeds e ON s.id=e.song_id WHERE 1=1"""
    if no_vocal:
        sql += " AND s.has_vocals='no'"
    rows = conn.execute(sql).fetchall()
    conn.close()
    scores = []
    for sid, fn, fp, bpm, rms, dur, emb in rows:
        ae = np.frombuffer(emb, dtype=np.float32)
        ae = ae / (np.linalg.norm(ae) + 1e-8)
        sim = float((te * ae).sum())
        scores.append((sim, fn, fp, bpm, dur))
    scores.sort(reverse=True)
    return scores[:top_n]


def pick_clip_position(audio_path, target_duration, mood="steady"):
    import librosa
    y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=180)
    hop = int(sr / 4)
    rms = librosa.feature.rms(y=y, frame_length=hop*2, hop_length=hop)[0]
    n_sec = len(rms) * hop / sr
    if n_sec < target_duration + 2:
        return 0.0, min(n_sec, target_duration)
    best_start = 0
    best_score = -1e9
    mean_rms = np.mean(rms)
    for start_frame in range(0, len(rms) - int(target_duration*sr/hop), int(sr/hop)):
        seg_rms = rms[start_frame:start_frame + int(target_duration*sr/hop)]
        seg_mean = np.mean(seg_rms)
        seg_var = np.var(seg_rms)
        if mood == "climax":
            score = seg_mean * 2 - seg_var * 0.1
        elif mood == "calm":
            score = -seg_mean - seg_var * 0.5
        else:
            score = -abs(seg_mean - mean_rms) - seg_var * 0.2
        if score > best_score:
            best_score = score
            best_start = start_frame
    start_sec = best_start * hop / sr
    return start_sec, start_sec + target_duration


def trim_audio(src_path, start, end, out_wav):
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(start), "-to", str(end),
        "-i", src_path, "-ar", "44100", "-ac", "1",
        "-acodec", "pcm_s16le", out_wav
    ], check=True, capture_output=True)


def read_wav(path):
    w = wave.open(path, 'rb')
    nch = w.getnchannels(); sw = w.getsampwidth(); fr = w.getframerate(); nf = w.getnframes()
    raw = w.readframes(nf); w.close()
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


def crossfade_wavs(wav_paths, out_wav, overlap=2.0, target_rms=0.12):
    segs = [read_wav(p) for p in wav_paths]
    fr0, nch0 = segs[0][0], segs[0][1]
    overlap_frames = int(overlap * fr0)
    lens = [len(s) // nch0 for _, _, s in segs]
    norm = []
    for fr, nch, samples in segs:
        rms = float(np.sqrt(np.mean(samples**2)))
        scale = min(target_rms / max(rms, 1e-6), 3.0)
        norm.append(samples * scale)
    starts = [0]
    for i in range(1, len(norm)):
        starts.append(starts[-1] + lens[i-1] - overlap_frames)
    total_frames = starts[-1] + lens[-1]
    out = np.zeros(total_frames * nch0, dtype=np.float64)
    for i, seg in enumerate(norm):
        slen = len(seg) // nch0
        fin = int(overlap * fr0)
        fout = int(overlap * fr0)
        for fr in range(slen):
            g = 1.0
            if i == 0 and fr < fin:
                g *= eq_power(fr/fin, 'in')
            if i == len(norm)-1 and fr >= slen - fout:
                g *= eq_power((slen-fr)/fout, 'out')
            if g <= 0.001:
                continue
            for c in range(nch0):
                out[(starts[i]+fr)*nch0+c] += seg[fr*nch0+c] * g
    peak = float(np.max(np.abs(out)))
    if peak > 0.95:
        out *= 0.95 / peak
    write_wav(out_wav, fr0, nch0, out)
    return total_frames / fr0


def generate_bgm(script_text, video_file, mood_override="", progress=gr.Progress()):
    if not script_text or not video_file:
        return None, "Please paste script and upload video"
    progress(0.05, desc="Probing video...")
    duration = probe_video_duration(video_file)
    if not duration:
        return None, "Cannot read video duration. Is ffmpeg installed?"
    progress(0.1, desc="Parsing scenes...")
    scenes = parse_script_scenes(script_text)
    if not scenes:
        scenes = [{"id": "full", "text": script_text}]
    n = len(scenes)
    segment_len = duration / n
    overlap = 2.0
    actual_seg_len = segment_len + overlap * (n-1) / n
    progress(0.2, desc=f"{n} scenes, ~{segment_len:.1f}s each")

    work_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work")
    os.makedirs(work_dir, exist_ok=True)

    default_moods = {
        "对峙": ("tense confrontation dark cinematic suspense", "steady"),
        "打斗": ("intense battle action percussion epic", "climax"),
        "悲伤": ("sad emotional piano melancholic lonely", "calm"),
        "温暖": ("warm heartfelt strings family healing", "steady"),
        "温馨": ("cozy gentle acoustic peaceful", "calm"),
        "愤怒": ("angry intense dramatic buildup", "climax"),
        "冷静": ("calm determined cold resolve", "steady"),
        "惊喜": ("wonder discovery magical uplifting", "climax"),
        "阴谋": ("mysterious conspiracy ominous low drone", "calm"),
        "回忆": ("nostalgic memory sentimental piano", "calm"),
    }

    wav_paths = []
    log_lines = [f"Video: {duration:.1f}s, {n} scenes"]

    for i, scene in enumerate(scenes):
        progress(0.2 + 0.6*i/n, desc=f"Scene {i+1}/{n}")
        text = scene["text"]
        query = ""
        mood = "steady"
        for kw, (q, m) in default_moods.items():
            if kw in text:
                query = q
                mood = m
                break
        if not query:
            query = "emotional cinematic drama underscore"
        if mood_override:
            query = mood_override
        results = search_music(query, top_n=3, no_vocal=True)
        if not results:
            log_lines.append(f"Scene {scene['id']}: no match")
            continue
        sim, fn, fp, bpm, dur = results[0]
        log_lines.append(f"Scene {scene['id']}: {fn[:40]} ({sim:.2f})")
        try:
            start, end = pick_clip_position(fp, actual_seg_len, mood=mood)
            out_wav = os.path.join(work_dir, f"seg{i+1}.wav")
            trim_audio(fp, start, end, out_wav)
            wav_paths.append(out_wav)
        except Exception as e:
            log_lines.append(f"Scene {scene['id']}: trim failed {e}")

    if not wav_paths:
        return None, "No segments produced"

    progress(0.85, desc="Crossfading...")
    full_wav = os.path.join(work_dir, "crossfade_full.wav")
    total = crossfade_wavs(wav_paths, full_wav, overlap=overlap)

    progress(0.95, desc="Exporting MP3...")
    out_mp3 = os.path.join(work_dir, "output_bgm.mp3")
    subprocess.run([
        "ffmpeg", "-y", "-i", full_wav,
        "-t", str(duration),
        "-codec:a", "libmp3lame", "-b:a", "192k",
        out_mp3
    ], check=True, capture_output=True)

    log_lines.append(f"Done! {total:.1f}s -> {out_mp3}")
    return out_mp3, "\n".join(log_lines)


with gr.Blocks(title="Drama BGM Generator") as demo:
    gr.Markdown("# Drama BGM Generator\nPaste script -> upload video -> auto search & crossfade -> MP3")
    with gr.Row():
        with gr.Column(scale=1):
            script_input = gr.Textbox(label="Script (paste full episode)", lines=15)
            video_input = gr.File(label="Episode video", file_types=[".mp4", ".mov", ".avi"])
            mood_input = gr.Textbox(label="Mood override (English, optional)", placeholder="tense thriller dark cinematic")
            btn = gr.Button("Generate BGM", variant="primary")
        with gr.Column(scale=1):
            audio_out = gr.Audio(label="Generated BGM")
            log_out = gr.Textbox(label="Log", lines=15)
    btn.click(fn=generate_bgm, inputs=[script_input, video_input, mood_input], outputs=[audio_out, log_out])


if __name__ == "__main__":
    demo.launch(inbrowser=True)
