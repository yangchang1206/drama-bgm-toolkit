# -*- coding: utf-8 -*-
"""
选曲重复度诊断：为什么「每集都有重复的音乐」。

不依赖 DashScope API —— 直接拿索引里的曲目向量互相查询，
量化两件事：
  1) 曲库向量空间的拥挤度（一个 query 会同时命中多少几乎一样的曲子）
  2) 当前选曲逻辑下，多集连配的重复率（以及修复后的对比）

用法：
  python tools/analyze_dup.py --index web/web_embeddings.json
"""
import argparse
import base64
import json
import os
import sys

import numpy as np


def load_index(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    fn = np.array([e["fn"] for e in d])
    dur = np.array([e.get("dur") or 0 for e in d], dtype=np.float32)
    bpm = np.array([e.get("bpm") or 0 for e in d], dtype=np.float32)
    eng = np.array([e.get("eng") if e.get("eng") is not None else -1 for e in d], dtype=np.float32)
    raw = np.stack([
        np.frombuffer(base64.b64decode(e["v"]), dtype=np.uint8).astype(np.float32) for e in d
    ])
    M = (raw - 128.0) / 127.0                      # 与前端 decodeVec 一致
    M /= np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)   # 与 normF32 一致
    return fn, M, dur, bpm, eng


def dur_fit(song_dur, seg_dur):
    s = np.where(song_dur > 0, song_dur, 0)
    out = np.full_like(s, 0.5)
    big = s >= seg_dur
    out[big] = 1 - np.minimum(0.15, (s[big] - seg_dur) / seg_dur * 0.15)
    mid = (~big) & (s >= seg_dur * 0.6)
    out[mid] = 0.7
    low = (~big) & (~mid)
    out[low] = np.maximum(0, s[low] / seg_dur * 0.5)
    out[song_dur <= 0] = 0.5
    return out


def bpm_fit(bpm, want):
    out = np.full_like(bpm, 0.5)
    ok = bpm > 0
    out[ok] = 1 - np.minimum(1, np.abs(bpm[ok] - want) / 60)
    return out


def eng_fit(song_eng, seg_eng):
    out = np.full_like(song_eng, 0.5)
    ok = song_eng >= 0
    out[ok] = 1 - np.abs(song_eng[ok] - seg_eng)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="web/web_embeddings.json")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    fn, M, dur, bpm, eng = load_index(args.index)
    N = len(fn)
    rng = np.random.default_rng(args.seed)
    print("=" * 62)
    print("索引：%d 首，向量维度 %d" % (N, M.shape[1]))
    print("=" * 62)

    # ---------- 1. 向量空间拥挤度 ----------
    print("\n【1】曲库向量空间拥挤度（随机 400 首做 query，扫全库）")
    SAMP = min(400, N)
    qi = rng.choice(N, SAMP, replace=False)
    S = M[qi] @ M.T
    S[np.arange(SAMP), qi] = -9
    top = np.sort(S, axis=1)[:, ::-1][:, :20]
    spread = top[:, 0] - top[:, 9]
    print("  top1 余弦 均值 %.4f ｜ top5 %.4f ｜ top10 %.4f ｜ top20 %.4f"
          % (top[:, 0].mean(), top[:, 4].mean(), top[:, 9].mean(), top[:, 19].mean()))
    print("  top10 内部跨度（第1名−第10名）：均值 %.4f ｜ 中位 %.4f"
          % (spread.mean(), np.median(spread)))
    print("  → 跨度越小 = 前 10 名几乎等价，换谁都听不出差别（=「重复感」的直接来源）")
    p10, p50, p90 = np.percentile(top[:, 0], [10, 50, 90])
    print("  top1 余弦分位：10%%=%.3f  50%%=%.3f  90%%=%.3f" % (p10, p50, p90))

    # 高相似邻居数量：有多少首曲子拥有 ≥5 个余弦 >0.9 的近邻
    cnt90 = (S > 0.90).sum(axis=1)
    print("  每首曲子余弦>0.90 的近邻数：均值 %.1f ｜ 中位 %.0f ｜ 最大 %d"
          % (cnt90.mean(), np.median(cnt90), cnt90.max()))

    # ---------- 2. 模拟多集连配 ----------
    print("\n【2】模拟 3 集连配（每集 4 个乐段），情绪档序列相同")
    print("    用曲库向量代替 query 向量（逻辑上等价：query 固定 ⇒ 排序固定）")

    NSEG, NEP = 4, 3
    seg_dur = np.array([25.0, 20.0, 30.0, 22.0], dtype=np.float32)

    def pick(sim_row, used, seg_idx, add_to_used_mode):
        """复刻前端 pickTracks：四维打分 + usedSongs 过滤。"""
        d = dur_fit(dur, seg_dur[seg_idx])
        b = bpm_fit(bpm, 110.0)
        e = eng_fit(eng, 0.5)
        sc = 0.45 * sim_row + 0.25 * d + 0.20 * b + 0.10 * e
        order = np.argsort(-sc)
        out = []
        for i in order:
            if fn[i] in used:
                continue
            out.append(int(i))
            if len(out) >= 10:
                break
        return out

    def run(mode):
        """mode='now' 复刻现状；'fixed' 用跨集去重 + 多候选轮转。"""
        used = set()
        picked_by_ep = []
        for ep in range(NEP):
            if mode == "now":
                used = set()          # ← 关键：现状是每集重置
            seeds = []
            ep_picks = []
            for k in range(NSEG):
                # query 向量：取自曲库（同一个 seq 在每集里完全一致）
                qv = M[qi[k]]
                row = qv @ M.T
                cand = pick(row, used, k, mode)
                take = cand[0]
                ep_picks.append(fn[take])
                if mode == "now":
                    used.add(fn[take])          # 现状：只把第 1 名标记已用
                else:
                    for c in cand:
                        used.add(fn[c])         # 修复：整个候选窗口都算用过
                seeds.append(cand)
            picked_by_ep.append(ep_picks)
        return picked_by_ep

    for mode, label in (("now", "现状逻辑（每集重置 usedSongs，只排第1名）"),
                        ("fixed", "修复思路（跨集共用已用池 + 候选窗口全占用）")):
        got = run(mode)
        allp = [x for ep in got for x in ep]
        uniq = len(set(allp))
        print("\n  %s" % label)
        for i, ep in enumerate(got):
            print("    第%d集: %s" % (i + 1, " ｜ ".join(s[:34] for s in ep)))
        print("    共 %d 个乐段 → 不同曲目 %d 首（重复率 %.0f%%）"
              % (len(allp), uniq, (1 - uniq / len(allp)) * 100))
        # 集间重合
        s0, s1 = set(got[0]), set(got[1])
        print("    第1集 ∩ 第2集 = %d 首" % len(s0 & s1))

    # ---------- 3. 候选窗口重叠 ----------
    print("\n【3】相邻乐段的候选列表重叠（现状：只排第1名）")
    used = set()
    prev = None
    for k in range(NSEG):
        cand = pick(M[qi[k]] @ M.T, used, k, "now")
        cur = set(fn[c] for c in cand)
        if prev is not None:
            print("    段%d→段%d 候选 10 首重叠 %d 首" % (k, k + 1, len(prev & cur)))
        prev = cur
        used.add(fn[cand[0]])


if __name__ == "__main__":
    main()
