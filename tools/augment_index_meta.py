#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
给**已有**的 web_embeddings.json 补上时长/节奏/能量/人声元数据，**不重新调接口、不重新嵌入**。

为什么需要这个脚本
------------------
`build_web_index.py` 重建索引要调 DashScope 重新嵌入 5459 首（慢且耗额度），
但这些曲目在 `music_db.sqlite` 里**早就有** duration / bpm / rms / mood / has_vocals，
只是老索引只写了 {fn, voc, v}。前端「四维打分」（情绪 + 时长 + BPM + 能量）
依赖 dur/bpm/eng，缺了就只能整段降级成中性值。

所以：向量照抄，元数据从 sqlite 按 filename 合并进来 —— 秒级完成、零成本。

字段契约（与 web/index.html 的 durFit/bpmFit/engFit 对应）
--------------------------------------------------------
    dur  时长(秒)   来自 songs.duration
    bpm  每分钟拍数  来自 songs.bpm（0/空 → null，前端当中性）
    eng  能量档      来自 songs.mood 中段：低能量→0 / 中能量→0.5 / 高能量→1
    spd  速度档      来自 songs.mood 前段：慢节奏→0 / 中速→0.5 / 快节奏→1
    ton  调性词      来自 songs.mood 后段：暗沉/紧张/燃/欢快/抒情…（保留原词，供规则层参考）
    voc  人声标记    来自 songs.has_vocals：是/yes/疑似 → "yes"（前端会过滤掉），其余 → "no"。
                     同名多行取保守值：任一行判有人声即 "yes"（与 vocIsVocal() 同口径）

用法：
    python tools/augment_index_meta.py \
        --index drama-bgm-site/web_embeddings.json \
        --db "D:/豆包BGM/music_db.sqlite" \
        --out   web/web_embeddings.json
"""
import argparse
import json
import os
import re
import sys

# mood 形如「中速/中能量/暗沉」；早期有少量脏值（错误信息、空），一律跳过
MOOD_RE = re.compile(r"^(?P<spd>[^/]*)/(?P<eng>[^/]*)/(?P<ton>[^/]*)$")
SPD_MAP = {"慢节奏": 0.0, "慢速": 0.0, "中速": 0.5, "快节奏": 1.0, "快速": 1.0}
ENG_MAP = {"低能量": 0.0, "中能量": 0.5, "高能量": 1.0}
#: 人声判定——与 build_web_index.py 的 VOCAL_FLAGS、前端 vocIsVocal() 三处必须一致
VOCAL_FLAGS = {"是", "yes", "疑似"}


def parse_mood(mood):
    """→ (spd, eng, ton)；解析不出返回 (None, None, '')"""
    m = (mood or "").strip()
    mm = MOOD_RE.match(m)
    if not mm:
        return None, None, ""
    spd = SPD_MAP.get(mm.group("spd").strip())
    eng = ENG_MAP.get(mm.group("eng").strip())
    ton = mm.group("ton").strip()
    if len(ton) > 8 or "Error" in ton or "error" in ton:
        ton = ""
    return spd, eng, ton


def load_meta(db_path):
    """→ {filename: {dur, bpm, eng, spd, ton, voc}}

    同名多行时：dur/bpm/eng/spd/ton 取时长最大的那条（避免误配到重复项）；
    voc 例外——任一行的 has_vocals 判定有人声，就记 "yes"（保守）。"""
    import sqlite3
    conn = sqlite3.connect(db_path)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(songs)").fetchall()}
    need = {"filename", "duration", "bpm", "rms", "mood"}
    if not need.issubset(cols):
        conn.close()
        raise SystemExit("songs 表缺少字段：%s" % ", ".join(sorted(need - cols)))
    has_voc = "has_vocals" in cols          # 老库可能没有该列，缺了就不动索引里的 voc
    sel = "filename, duration, bpm, rms, mood" + (", has_vocals" if has_voc else "")
    rows = conn.execute("SELECT %s FROM songs" % sel).fetchall()
    conn.close()

    meta = {}
    vocs = {}
    for row in rows:
        fn, dur, bpm, rms, mood = row[:5]
        if not fn:
            continue
        if has_voc:
            vocs.setdefault(fn, set()).add((row[5] or "").strip())
        spd, eng, ton = parse_mood(mood)
        d = float(dur) if dur and dur > 0 else None
        b = float(bpm) if bpm and bpm > 0 else None
        r = float(rms) if rms and rms > 0 else None
        cur = meta.get(fn)
        if cur is None or (d or 0) > (cur.get("dur") or 0):
            meta[fn] = {"dur": d, "bpm": b, "rms": r, "eng": eng, "spd": spd, "ton": ton}
    if has_voc:
        for fn, m in meta.items():
            m["voc"] = "yes" if (vocs.get(fn, set()) & VOCAL_FLAGS) else "no"
    return meta


def main():
    ap = argparse.ArgumentParser(description="给已有索引补时长/节奏/能量/人声元数据（不重新嵌入）")
    ap.add_argument("--index", required=True, help="现有 web_embeddings.json（含向量）")
    ap.add_argument("--db", required=True, help="music_db.sqlite")
    ap.add_argument("--out", required=True, help="输出索引路径")
    ap.add_argument("--round-bpm", type=float, default=0.1, help="bpm 保留小数位精度")
    args = ap.parse_args()

    if not os.path.isfile(args.index):
        raise SystemExit("找不到索引：%s" % args.index)
    if not os.path.isfile(args.db):
        raise SystemExit("找不到数据库：%s" % args.db)

    print("读取索引 ...")
    with open(args.index, "r", encoding="utf-8") as f:
        idx = json.load(f)
    print("  %d 条" % len(idx))

    print("读取曲库元数据 ...")
    meta = load_meta(args.db)
    print("  %d 条元数据" % len(meta))

    hit = 0
    stat = {"dur": 0, "bpm": 0, "eng": 0, "spd": 0, "ton": 0, "voc": 0}
    voc_fixed = 0
    out = []
    for e in idx:
        fn = e.get("fn")
        m = meta.get(fn)
        item = dict(e)
        if m:
            hit += 1
            if m["dur"]:
                item["dur"] = round(m["dur"], 1)
                stat["dur"] += 1
            if m["bpm"]:
                item["bpm"] = round(m["bpm"], 1)
                stat["bpm"] += 1
            if m["eng"] is not None:
                item["eng"] = m["eng"]
                stat["eng"] += 1
            if m["spd"] is not None:
                item["spd"] = m["spd"]
                stat["spd"] += 1
            if m["ton"]:
                item["ton"] = m["ton"]
                stat["ton"] += 1
            if m.get("voc"):
                if item.get("voc") != m["voc"]:
                    voc_fixed += 1
                item["voc"] = m["voc"]
                stat["voc"] += 1
        out.append(item)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print("\n=== 完成 ===")
    print("索引条目：%d，命中元数据：%d（%.1f%%）" % (len(out), hit, 100.0 * hit / max(1, len(out))))
    print("字段覆盖：时长 %d ｜ BPM %d ｜ 能量 %d ｜ 速度 %d ｜ 调性 %d ｜ 人声 %d（其中修正 %d 条）"
          % (stat["dur"], stat["bpm"], stat["eng"], stat["spd"], stat["ton"], stat["voc"], voc_fixed))
    dist = {}
    for i in out:
        k = str(i.get("voc"))
        dist[k] = dist.get(k, 0) + 1
    print("人声标记分布：%s" % dist)
    print("输出：%s（%.2f MB）" % (args.out, os.path.getsize(args.out) / 1048576))

    # 体积回归护栏：元数据只该带来几十 KB 增长
    old_mb = os.path.getsize(args.index) / 1048576
    new_mb = os.path.getsize(args.out) / 1048576
    print("体积：%.2f MB → %.2f MB（%+.1f KB）" % (old_mb, new_mb, (new_mb - old_mb) * 1024))

    # 抽样打印，肉眼可核
    sample = [x for x in out if "dur" in x][:3]
    for s in sample:
        print("  样例：%s  dur=%s bpm=%s eng=%s spd=%s ton=%s voc=%s"
              % (s["fn"][:32], s.get("dur"), s.get("bpm"), s.get("eng"), s.get("spd"), s.get("ton"), s.get("voc")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
