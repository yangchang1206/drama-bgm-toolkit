# -*- coding: utf-8 -*-
"""
短剧BGM工作台
布局：左(剧本/视频) | 中(情绪弧线时间线) | 右(段详情编辑)
"""
import os, re, sys, subprocess, sqlite3, math, wave, struct, json, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

import gradio as gr

# ============ 基础工具 ============

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


def search_music(query, top_n=10, no_vocal=True):
    model, processor = get_model()
    import torch
    inp = processor(text=[query], return_tensors="pt", padding=True)
    with torch.no_grad():
        out = model.get_text_features(**inp)
        te = out.pooler_output.numpy()[0]
        te = te / np.linalg.norm(te)
    conn = sqlite3.connect(config.DB_PATH)
    sql = """SELECT s.id, s.filename, s.fullpath, s.bpm, s.duration, e.embed
             FROM songs s JOIN clap_embeds e ON s.id=e.song_id WHERE 1=1"""
    if no_vocal:
        sql += " AND s.has_vocals IN ('no','否')"
    rows = conn.execute(sql).fetchall()
    conn.close()
    scores = []
    for sid, fn, fp, bpm, dur, emb in rows:
        ae = np.frombuffer(emb, dtype=np.float32)
        ae = ae / (np.linalg.norm(ae) + 1e-8)
        sim = float((te * ae).sum())
        scores.append({"sim": round(sim, 3), "filename": fn, "path": fp,
                       "bpm": bpm, "duration": dur})
    scores.sort(key=lambda x: -x["sim"])
    return scores[:top_n]


# 情绪关键词 → 查询词
MOOD_MAP = {
    "紧张/对峙": ("tense confrontation dark cinematic suspense", "steady"),
    "打斗/爆发": ("intense battle action percussion epic", "climax"),
    "悲伤/委屈": ("sad emotional piano melancholic lonely", "calm"),
    "温暖/治愈": ("warm heartfelt strings family healing", "steady"),
    "愤怒/反击": ("angry intense dramatic buildup", "climax"),
    "冷静/霸气": ("calm determined cold resolve epic", "steady"),
    "惊喜/发现": ("wonder discovery magical uplifting", "climax"),
    "阴谋/悬疑": ("mysterious conspiracy ominous low drone", "calm"),
    "回忆/怀旧": ("nostalgic memory sentimental piano", "calm"),
    "温馨/日常": ("cozy gentle acoustic guitar peaceful", "calm"),
}


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
        seg = rms[start_frame:start_frame + int(target_duration*sr/hop)]
        sm = np.mean(seg); sv = np.var(seg)
        if mood == "climax":
            score = sm * 2 - sv * 0.1
        elif mood == "calm":
            score = -sm - sv * 0.5
        else:
            score = -abs(sm - mean_rms) - sv * 0.2
        if score > best_score:
            best_score = score; best_start = start_frame
    return best_start * hop / sr, best_start * hop / sr + target_duration


# ============ crossfade ============

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
        for fr in range(slen):
            g = 1.0
            if i == 0 and fr < overlap_frames:
                g *= eq_power(fr/overlap_frames, 'in')
            if i == len(norm)-1 and fr >= slen - overlap_frames:
                g *= eq_power((slen-fr)/overlap_frames, 'out')
            if g <= 0.001: continue
            for c in range(nch0):
                out[(starts[i]+fr)*nch0+c] += seg[fr*nch0+c] * g
    peak = float(np.max(np.abs(out)))
    if peak > 0.95: out *= 0.95 / peak
    write_wav(out_wav, fr0, nch0, out)
    return total_frames / fr0


# ============ 工作台状态 ============

# state: {"duration": float, "segments": [{"id","mood","query","track_idx","candidates","start","end","wav"}], "video": path}

def do_analyze(script_text, video_file, progress=gr.Progress()):
    if not script_text or not video_file:
        return None, "请粘贴剧本并上传视频", ""
    progress(0.1, "探测视频时长...")
    duration = probe_video_duration(video_file)
    if not duration:
        return None, "无法读取视频时长", ""
    scenes = parse_script_scenes(script_text)
    if not scenes:
        scenes = [{"id": "full", "text": script_text}]
    n = len(scenes)
    seg_len = duration / n
    overlap = 2.0
    actual_seg_len = seg_len + overlap * (n-1) / n

    progress(0.2, f"分{n}场，自动选曲...")
    segments = []
    for i, scene in enumerate(scenes):
        progress(0.2 + 0.6*i/n, f"场{scene['id']}搜曲...")
        text = scene["text"]
        # 自动识别情绪
        detected = "紧张/对峙"
        for kw, (q, m) in MOOD_MAP.items():
            if any(k in text for k in kw.split("/")):
                detected = kw
                break
        query, mood = MOOD_MAP[detected]
        cands = search_music(query, top_n=10)
        if not cands:
            continue
        track = cands[0]
        try:
            start, end = pick_clip_position(track["path"], actual_seg_len, mood=mood)
        except Exception:
            start, end = 0, actual_seg_len
        segments.append({
            "id": scene["id"], "time_start": round(i*seg_len, 1),
            "time_end": round((i+1)*seg_len, 1),
            "mood": detected, "query": query,
            "candidates": cands, "track_idx": 0,
            "start": round(start, 1), "end": round(end, 1),
            "wav": None
        })

    state = {"duration": duration, "segments": segments, "video": video_file}
    # 中间时间线显示
    timeline = "\n".join(
        f"【{s['id']}】{s['time_start']}-{s['time_end']}s | {s['mood']} | {s['candidates'][s['track_idx']]['filename'][:35]}"
        for s in segments
    )
    return state, f"✅ 完成：视频{duration:.1f}s，分{n}段。点中间段查看详情。", timeline


def show_segment(state, idx):
    if not state or not state.get("segments"):
        return state, "未分析", "", 0, 0, "", ""
    idx = int(idx)
    s = state["segments"][idx]
    cands = s["candidates"]
    cur = cands[s["track_idx"]]
    # 试听该段
    work = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work")
    os.makedirs(work, exist_ok=True)
    wav_path = os.path.join(work, f"seg_preview_{idx}.wav")
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(s["start"]), "-to", str(s["end"]),
        "-i", cur["path"], "-ar", "44100", "-ac", "1", "-acodec", "pcm_s16le", wav_path
    ], capture_output=True)
    s["wav"] = wav_path
    # 候选列表
    cand_list = "\n".join(
        f"[{i}] {c['filename'][:50]} (相似度{c['sim']})" for i, c in enumerate(cands)
    )
    return (state,
            f"段{idx+1} / {len(state['segments'])}",
            cur["filename"],
            s["start"], s["end"],
            s["mood"], cand_list)


def change_track(state, idx, new_track_idx):
    if not state: return state, "未分析"
    idx = int(idx)
    new_track_idx = int(new_track_idx)
    s = state["segments"][idx]
    if new_track_idx < len(s["candidates"]):
        s["track_idx"] = new_track_idx
        # 重新选截取点
        query, mood = MOOD_MAP.get(s["mood"], ("emotional cinematic", "steady"))
        try:
            st, en = pick_clip_position(s["candidates"][new_track_idx]["path"],
                                        s["time_end"]-s["time_start"]+2, mood=mood)
            s["start"], s["end"] = round(st,1), round(en,1)
        except Exception:
            pass
    return show_segment(state, idx)[:6] + ("",)


def adjust_clip(state, idx, new_start, new_end):
    if not state: return state
    idx = int(idx)
    state["segments"][idx]["start"] = float(new_start)
    state["segments"][idx]["end"] = float(new_end)
    return state


def do_export(state, progress=gr.Progress()):
    if not state or not state["segments"]:
        return None, "请先分析"
    progress(0.1, "裁剪各段...")
    work = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work")
    os.makedirs(work, exist_ok=True)
    wav_paths = []
    for i, s in enumerate(state["segments"]):
        track = s["candidates"][s["track_idx"]]
        wav = os.path.join(work, f"seg_{i}.wav")
        subprocess.run([
            "ffmpeg", "-y", "-ss", str(s["start"]), "-to", str(s["end"]),
            "-i", track["path"], "-ar", "44100", "-ac", "1", "-acodec", "pcm_s16le", wav
        ], capture_output=True)
        wav_paths.append(wav)
    progress(0.7, "crossfade叠加拼接...")
    full_wav = os.path.join(work, "crossfade_full.wav")
    total = crossfade_wavs(wav_paths, full_wav, overlap=2.0)
    progress(0.9, "导出MP3...")
    out_mp3 = os.path.join(work, "output_bgm.mp3")
    subprocess.run([
        "ffmpeg", "-y", "-i", full_wav, "-t", str(state["duration"]),
        "-codec:a", "libmp3lame", "-b:a", "192k", out_mp3
    ], check=True, capture_output=True)
    return out_mp3, f"✅ 导出完成！{state['duration']:.1f}s"


# ============ UI ============

CUSTOM_CSS = """
#main-title { text-align:center; margin-bottom:4px; }
#main-title h1 { font-size:26px; font-weight:700; color:#1a1a2e; margin:0; }
#subtitle { text-align:center; color:#888; margin-bottom:14px; font-size:13px; }
"""

with gr.Blocks(title="BGM工作台", css=CUSTOM_CSS) as demo:
    gr.HTML('<div id="main-title"><h1>🎬 BGM 工作台</h1></div>', elem_id="main-title")
    gr.HTML('<div id="subtitle">剧本 + 视频 → 自动分段选曲 → 可视化调整 → 导出MP3</div>', elem_id="subtitle")

    state = gr.State({})
    cur_idx = gr.State(0)

    # 音乐库管理
    with gr.Accordion("⚙️ 音乐库设置", open=False):
        def get_db_status():
            try:
                import importlib; importlib.reload(config)
            except Exception: pass
            root = config.MUSIC_ROOT
            db = config.DB_PATH
            if not os.path.exists(db):
                return f"当前库: {root}\n数据库未建立"
            try:
                conn = sqlite3.connect(db)
                total = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
                inst = conn.execute("SELECT COUNT(*) FROM songs WHERE has_vocals IN ('no','否')").fetchone()[0]
                conn.close()
                return f"当前库: {root}\n歌曲: {total} 首（纯器乐 {inst}）"
            except Exception as e:
                return f"当前库: {root}\n错误: {e}"

        def switch_lib(new_path):
            global _MODEL, _PROCESSOR
            new_path = new_path.strip().strip('"').strip("'")
            if not os.path.isdir(new_path):
                return f"路径不存在: {new_path}"
            cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.py")
            with open(cfg_path, "r", encoding="utf-8") as f: c = f.read()
            c = re.sub(r'MUSIC_ROOT\s*=\s*r?"[^"]*"', f'MUSIC_ROOT = r"{new_path}"', c)
            with open(cfg_path, "w", encoding="utf-8") as f: f.write(c)
            import importlib; importlib.reload(config)
            _MODEL = None; _PROCESSOR = None
            return get_db_status()

        db_status = gr.Textbox(label="数据库状态", value=get_db_status(), lines=3, interactive=False)
        new_path = gr.Textbox(label="新音乐库路径", placeholder=r"如 D:\AA-音色")
        with gr.Row():
            sw = gr.Button("切换此库")
            bb = gr.Button("🔨 建库（首次30-60分钟）")
        sw.click(switch_lib, [new_path], [db_status])

    with gr.Row():
        # 左：输入
        with gr.Column(scale=1):
            gr.Markdown("### ① 输入")
            script_in = gr.Textbox(label="剧本", lines=10,
                                   placeholder="粘贴整集剧本（含 41-1、41-2 等场号）")
            video_in = gr.File(label="集数视频", file_types=[".mp4",".mov",".avi"])
            analyze_btn = gr.Button("🔍 分析并自动选曲", variant="primary")
            status = gr.Textbox(label="状态", lines=2, interactive=False)

        # 中：时间线
        with gr.Column(scale=1.2):
            gr.Markdown("### ② 情绪弧线时间线")
            timeline = gr.Textbox(label="各段（点序号查看）", lines=12, interactive=False)
            seg_selector = gr.Dropdown(label="选择段", choices=[], interactive=True)
            export_btn = gr.Button("🎵 生成并导出MP3", variant="primary")

        # 右：详情
        with gr.Column(scale=1.2):
            gr.Markdown("### ③ 段详情")
            seg_label = gr.Textbox(label="当前段", interactive=False)
            track_name = gr.Textbox(label="选中曲目", interactive=False)
            start_in = gr.Number(label="截取开始(秒)", value=0)
            end_in = gr.Number(label="截取结束(秒)", value=30)
            mood_in = gr.Dropdown(label="情绪", choices=list(MOOD_MAP.keys()), value="紧张/对峙")
            preview_audio = gr.Audio(label="试听此段")
            cand_in = gr.Dropdown(label="换一首（从候选）", choices=[])
            change_btn = gr.Button("换曲")
            adjust_btn = gr.Button("应用截取点调整")

    # 事件
    analyze_btn.click(do_analyze, [script_in, video_in], [state, status, timeline]).then(
        lambda s: (gr.update(choices=[f"段{i+1} ({seg['id']})" for i, seg in enumerate(s.get('segments',[]))]),
                   gr.update(choices=[str(i) for i in range(10)])),
        inputs=[state], outputs=[seg_selector, cand_in]
    )

    seg_selector.change(
        lambda s, c: (int(c.split(" ")[0].replace("段",""))-1,) if c else (0,),
        inputs=[state, seg_selector], outputs=[cur_idx]
    ).then(
        show_segment, [state, cur_idx],
        [state, seg_label, track_name, start_in, end_in, mood_in, cand_in]
    ).then(
        lambda s, idx: (s["segments"][int(idx)]["wav"],) if s and s.get("segments") else (None,),
        inputs=[state, cur_idx], outputs=[preview_audio]
    )

    change_btn.click(change_track, [state, cur_idx, cand_in],
                     [state, seg_label, track_name, start_in, end_in, mood_in, cand_in]).then(
        lambda s, idx: (s["segments"][int(idx)]["wav"],) if s and s.get("segments") else (None,),
        inputs=[state, cur_idx], outputs=[preview_audio]
    )

    adjust_btn.click(adjust_clip, [state, cur_idx, start_in, end_in], [state])

    export_btn.click(do_export, [state], [preview_audio, status])


if __name__ == "__main__":
    demo.launch(inbrowser=True, share=True)
