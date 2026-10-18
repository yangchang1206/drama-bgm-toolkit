# -*- coding: utf-8 -*-
"""
One-click database builder:
  Scan music folder -> librosa analysis (BPM/key/energy) -> CLAP embedding -> voice detection
Usage: python build_db.py
First run takes ~30-60 min (depends on song count), resumable.
"""
import os, sys, time, sqlite3
import numpy as np
import librosa

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

def init_db(conn):
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lib TEXT, subdir TEXT, filename TEXT, fullpath TEXT UNIQUE,
        ext TEXT, size_mb REAL, bpm REAL, key TEXT, mode TEXT,
        rms REAL, peak REAL, centroid REAL, duration REAL,
        mood TEXT, has_vocals TEXT DEFAULT 'unknown',
        analyzed INTEGER DEFAULT 0, analyzed_at TEXT,
        dup_group TEXT, dup_role TEXT, voice_checked INTEGER DEFAULT 0
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS clap_embeds (
        song_id INTEGER PRIMARY KEY,
        embed BLOB,
        extracted_at TEXT
    )""")
    conn.commit()

def scan_library():
    root = config.MUSIC_ROOT
    if not os.path.isdir(root):
        print(f"ERROR: music folder not found: {root}")
        sys.exit(1)
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in config.AUDIO_EXTS:
                continue
            full = os.path.join(dirpath, fn)
            size_mb = os.path.getsize(full) / 1024 / 1024
            rel = os.path.relpath(full, root)
            parts = rel.split(os.sep)
            lib = parts[0] if len(parts) > 1 else "root"
            subdir = os.path.dirname(rel)
            found.append((lib, subdir, fn, full, ext, size_mb))
    return found

def analyze_one(path):
    y, sr = librosa.load(path, sr=22050, mono=True, duration=120)
    if len(y) < sr:
        return None
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    rms = float(np.sqrt(np.mean(y**2)))
    peak = float(np.max(np.abs(y)))
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    duration = len(y) / sr
    return {"bpm": float(tempo), "key": "unknown", "mode": "unknown",
            "rms": rms, "peak": peak, "centroid": centroid, "duration": duration}

def main():
    os.environ["HF_ENDPOINT"] = config.HF_ENDPOINT
    print(f"Music root: {config.MUSIC_ROOT}")
    files = scan_library()
    print(f"Found {len(files)} audio files")

    conn = sqlite3.connect(config.DB_PATH, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    init_db(conn)

    c = conn.cursor()
    new_count = 0
    for lib, subdir, fn, full, ext, size_mb in files:
        c.execute("INSERT OR IGNORE INTO songs (lib,subdir,filename,fullpath,ext,size_mb) VALUES (?,?,?,?,?,?)",
                  (lib, subdir, fn, full, ext, size_mb))
        if c.rowcount > 0:
            new_count += 1
    conn.commit()
    print(f"New: {new_count}, analyzing audio...")

    rows = c.execute("SELECT id, fullpath FROM songs WHERE analyzed=0").fetchall()
    t0 = time.time()
    for i, (sid, fp) in enumerate(rows):
        try:
            r = analyze_one(fp)
            if r:
                c.execute("""UPDATE songs SET bpm=?, key=?, mode=?, rms=?, peak=?, centroid=?,
                             duration=?, analyzed=1, analyzed_at=? WHERE id=?""",
                          (r["bpm"], r["key"], r["mode"], r["rms"], r["peak"],
                           r["centroid"], r["duration"], time.strftime("%Y-%m-%d %H:%M"), sid))
            else:
                c.execute("UPDATE songs SET analyzed=1, analyzed_at=? WHERE id=?",
                          (time.strftime("%Y-%m-%d %H:%M"), sid))
            conn.commit()
        except Exception as e:
            print(f"  [{sid}] analyze failed: {str(e)[:60]}")
            c.execute("UPDATE songs SET analyzed=1 WHERE id=?", (sid,))
            conn.commit()
        if (i+1) % 50 == 0:
            el = time.time()-t0
            print(f"  librosa {i+1}/{len(rows)} speed={(i+1)/el:.1f} songs/min")

    print("\nLoading CLAP model...")
    import torch
    from transformers import ClapModel, ClapProcessor
    model = ClapModel.from_pretrained(config.CLAP_MODEL).eval()
    processor = ClapProcessor.from_pretrained(config.CLAP_MODEL)
    pending = c.execute("""SELECT s.id, s.fullpath FROM songs s
                          LEFT JOIN clap_embeds e ON s.id=e.song_id
                          WHERE e.song_id IS NULL""").fetchall()
    print(f"Pending embeddings: {len(pending)}")
    t0 = time.time()
    for i, (sid, fp) in enumerate(pending):
        try:
            audio, sr = librosa.load(fp, sr=48000, mono=True, duration=60)
            inputs = processor(audio=audio, sampling_rate=48000, return_tensors="pt")
            with torch.no_grad():
                out = model.get_audio_features(**inputs)
                emb = out.pooler_output.numpy().astype(np.float32).tobytes()
            c.execute("INSERT OR REPLACE INTO clap_embeds (song_id, embed, extracted_at) VALUES (?,?,?)",
                      (sid, emb, time.strftime("%Y-%m-%d %H:%M")))
            conn.commit()
        except Exception as e:
            print(f"  [{sid}] embed failed: {str(e)[:60]}")
        if (i+1) % 100 == 0:
            el = time.time()-t0
            print(f"  CLAP {i+1}/{len(pending)} speed={(i+1)/el:.1f} songs/min")

    print("\nLoading VAD model...")
    from silero_vad import load_silero_vad, get_speech_timestamps
    vad = load_silero_vad()
    pending_v = c.execute("SELECT id, fullpath FROM songs WHERE voice_checked=0").fetchall()
    t0 = time.time()
    for i, (sid, fp) in enumerate(pending_v):
        try:
            wav, _ = librosa.load(fp, sr=config.SAMPLE_RATE, mono=True, duration=60)
            if len(wav) >= config.SAMPLE_RATE:
                ts = get_speech_timestamps(torch.from_numpy(wav).float(), vad,
                                          sampling_rate=config.SAMPLE_RATE, threshold=0.3)
                sp = sum((t['end']-t['start']) for t in ts) / config.SAMPLE_RATE
                ratio = sp / min(60, len(wav)/config.SAMPLE_RATE)
                has = "yes" if ratio > config.VOICE_THRESHOLD_RATIO else "no"
            else:
                has = "no"
            c.execute("UPDATE songs SET has_vocals=?, voice_checked=1 WHERE id=?", (has, sid))
            conn.commit()
        except Exception as e:
            c.execute("UPDATE songs SET voice_checked=1 WHERE id=?", (sid,))
            conn.commit()
        if (i+1) % 100 == 0:
            el = time.time()-t0
            print(f"  VAD {i+1}/{len(pending_v)} speed={(i+1)/el:.1f} songs/min")

    total = c.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
    voc = c.execute("SELECT COUNT(*) FROM songs WHERE has_vocals IN ('yes','是')").fetchone()[0]
    emb_n = c.execute("SELECT COUNT(*) FROM clap_embeds").fetchone()[0]
    print(f"\n=== Done ===")
    print(f"Total songs: {total}")
    print(f"With vocals: {voc}")
    print(f"CLAP embeds: {emb_n}")
    print(f"Database: {config.DB_PATH}")
    conn.close()

if __name__ == "__main__":
    main()
