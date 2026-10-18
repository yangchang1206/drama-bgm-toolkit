# -*- coding: utf-8 -*-
"""
Natural language music search:
  python clap_search.py "tense thriller dark cinematic" --top 10
Args:
  --no-vocal   Only confirmed instrumental (has_vocals 否/no)
  --dedup      Drop duplicate copies (dup_role='dup'), keep primary/unique
  --top N      Return top N results
  --db PATH    music_db.sqlite path (default: config.DB_PATH)
"""
import os, sys, sqlite3, argparse
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="Emotion description, English works best, e.g. 'sad emotional piano'")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--no-vocal", action="store_true")
    ap.add_argument("--dedup", action="store_true")
    ap.add_argument("--db", default=config.DB_PATH, help="Path to music_db.sqlite (default: config.DB_PATH)")
    args = ap.parse_args()

    os.environ["HF_ENDPOINT"] = config.HF_ENDPOINT
    import torch
    from transformers import ClapModel, ClapProcessor

    model = ClapModel.from_pretrained(config.CLAP_MODEL).eval()
    processor = ClapProcessor.from_pretrained(config.CLAP_MODEL)
    inp = processor(text=[args.query], return_tensors="pt", padding=True)
    with torch.no_grad():
        out = model.get_text_features(**inp)
        te = out.pooler_output.numpy()[0]
        te = te / np.linalg.norm(te)

    conn = sqlite3.connect(args.db)
    sql = """SELECT s.id, s.filename, s.fullpath, s.lib, s.bpm, s.rms, s.duration, s.has_vocals, e.embed
             FROM songs s JOIN clap_embeds e ON s.id=e.song_id WHERE 1=1"""
    params = []
    # has_vocals 历史上中英两套取值（否/no、是/yes），按集合匹配；
    # dup_role 空串表示"无重复曲目"（不是 NULL），--dedup 只应排除 'dup' 副本
    if args.no_vocal:
        sql += " AND s.has_vocals IN ('no','否')"
    if args.dedup:
        sql += " AND COALESCE(s.dup_role,'')!='dup'"
    rows = conn.execute(sql, params).fetchall()

    scores = []
    for sid, fn, fp, lib, bpm, rms, dur, hv, emb in rows:
        ae = np.frombuffer(emb, dtype=np.float32)
        ae = ae / (np.linalg.norm(ae) + 1e-8)
        sim = float((te * ae).sum())
        scores.append((sim, fn, fp, lib, bpm, rms, dur))
    scores.sort(reverse=True)
    conn.close()

    print(f"\nQuery: {args.query}")
    print(f"Matches: {len(scores)}, Top {args.top}:\n")
    for i, (sim, fn, fp, lib, bpm, rms, dur) in enumerate(scores[:args.top], 1):
        print(f"{i:2d}. [{sim:.3f}] {fn}")
        print(f"    lib={lib}  bpm={bpm:.0f}  dur={dur:.0f}s")
        print(f"    {fp}\n")

if __name__ == "__main__":
    main()
