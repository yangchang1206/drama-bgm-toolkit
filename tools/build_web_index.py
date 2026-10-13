#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
构建浏览器工作台（web/index.html）所需的向量索引文件 web_embeddings.json。

背景：前端「匹配向量库 → 选曲」依赖一个预计算索引。查询侧用 DashScope
`text-embedding-v3`（1024 维），所以索引向量必须落在**同一个向量空间**，
否则余弦相似度没有意义（前端会直接报「向量空间不匹配」并中止）。

索引格式契约（与 web/index.html 的 getVec()/decodeVec() 严格对应）：
    [
      {"fn": "曲名.mp3", "voc": "no", "dur": 194.1, "v": "<base64>"},
      ...
    ]
    - fn  : 音频文件名（前端按小写文件名与本地文件对齐）
    - voc : "yes" = 有人声/疑似（前端会过滤掉），"no" = 可用
    - dur : 时长（秒），可选，供前端预估可截取长度
    - v   : base64(1024 字节)，每字节 1 维，前端解码为 (byte - 128) / 127

用法：
    set DASHSCOPE_API_KEY=sk-xxxx
    python tools/build_web_index.py --db music_db.sqlite --out web/web_embeddings.json

    # 试跑 20 条看格式
    python tools/build_web_index.py --db music_db.sqlite --out /tmp/test.json --limit 20

断点续跑：中途中断后重跑会自动复用 --out 对应的 .part.jsonl 进度文件。
"""
import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
DEFAULT_MODEL = "text-embedding-v3"
DEFAULT_DIMS = 1024
#: OpenAI 兼容模式下单批 input 上限为 10 条
MAX_BATCH = 10
VOCAL_FLAGS = {"是", "疑似", "yes"}


def parse_args():
    ap = argparse.ArgumentParser(description="构建 web/index.html 用的向量索引")
    ap.add_argument("--db", required=True, help="music_db.sqlite 路径（build_db.py 产物）")
    ap.add_argument("--out", required=True, help="输出 web_embeddings.json 路径")
    ap.add_argument("--api-key", default=os.environ.get("DASHSCOPE_API_KEY", ""),
                    help="DashScope API Key，默认读环境变量 DASHSCOPE_API_KEY")
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="兼容模式 embeddings 端点")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="嵌入模型（须与前端查询侧一致）")
    ap.add_argument("--dims", type=int, default=DEFAULT_DIMS, help="向量维度（前端按 1 字节=1 维解码）")
    ap.add_argument("--batch", type=int, default=MAX_BATCH, help="每批条数，上限 %d" % MAX_BATCH)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条（0 = 全部），用于试跑")
    ap.add_argument("--exclude-unknown", action="store_true",
                    help="连「人声未知」的曲目也排除（默认保留，与旧索引行为一致）")
    ap.add_argument("--sleep", type=float, default=0.2, help="每批之间的间隔秒数，防限流")
    ap.add_argument("--text-format", default="{stem} | {subdir} | {mood}",
                    help="生成待嵌入文本的模板，可用 {stem} {filename} {subdir} {mood}")
    ap.add_argument("--dry-run", action="store_true",
                    help="不调用接口，用确定性假向量跑通流程，仅用于校验格式与数据库读取")
    return ap.parse_args()


def load_rows(db_path, exclude_unknown):
    """从 songs 表取曲目。返回 [(id, filename, subdir, mood, has_vocals, duration)]"""
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cols = {r[1] for r in conn.execute("PRAGMA table_info(songs)").fetchall()}
    need = {"id", "filename", "subdir", "mood", "has_vocals", "duration"}
    if not need.issubset(cols):
        missing = need - cols
        conn.close()
        raise SystemExit("songs 表缺少字段 %s，请先跑 build_db.py 建库" % ", ".join(sorted(missing)))
    rows = conn.execute(
        "SELECT id, filename, subdir, mood, has_vocals, duration FROM songs ORDER BY id"
    ).fetchall()
    conn.close()

    out = []
    for r in rows:
        hv = (r["has_vocals"] or "").strip()
        if hv in VOCAL_FLAGS:
            continue
        if exclude_unknown and hv in ("", "unknown", "未知"):
            continue
        out.append((r["id"], r["filename"], r["subdir"] or "", r["mood"] or "unknown",
                    hv, r["duration"] or 0))
    return out


def build_text(row, template):
    _, filename, subdir, mood, _, _ = row
    stem = os.path.splitext(filename)[0]
    return template.format(stem=stem, filename=filename, subdir=subdir, mood=mood)


def embed_batch(texts, args):
    """请求一批文本向量。返回 list[list[float]]"""
    if args.dry_run:
        import hashlib
        out = []
        for t in texts:
            seed = hashlib.sha256(t.encode("utf-8")).digest()
            out.append([((seed[i % len(seed)] / 255.0) * 2 - 1) for i in range(args.dims)])
        return out
    body = json.dumps({
        "model": args.model,
        "input": texts,
        "dimensions": args.dims,
        "encoding_format": "float",
    }).encode("utf-8")
    req = urllib.request.Request(
        args.endpoint, data=body,
        headers={"Authorization": "Bearer " + args.api_key,
                 "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    data = sorted(payload["data"], key=lambda d: d.get("index", 0))
    return [d["embedding"] for d in data]


def quantize_int8(vec):
    """归一化后量化到 int8，再平移到 0~255，返回 base64（前端按 1 字节=1 维解码）"""
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        norm = 1.0
    q = [max(-127, min(127, int(round(x / norm * 127)))) for x in vec]
    return base64.b64encode(bytes(v + 128 for v in q)).decode("ascii")


def main():
    args = parse_args()
    if not args.api_key and not args.dry_run:
        raise SystemExit("缺少 API Key：请设置环境变量 DASHSCOPE_API_KEY，或用 --api-key 传入")
    if args.dry_run:
        args.api_key = args.api_key or "dry-run"
    if args.batch > MAX_BATCH:
        print("[warn] 兼容模式单批上限 %d，已自动收敛" % MAX_BATCH)
        args.batch = MAX_BATCH
    if not os.path.isfile(args.db):
        raise SystemExit("找不到数据库：%s" % args.db)

    rows = load_rows(args.db, args.exclude_unknown)
    if args.limit:
        rows = rows[:args.limit]
    print("待嵌入曲目：%d 首（已按人声规则过滤）" % len(rows))
    if not rows:
        raise SystemExit("没有可处理的曲目，请检查 has_vocals 字段取值")

    part_path = args.out + ".part.jsonl"
    done = {}
    if os.path.isfile(part_path):
        with open(part_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                    done[item["fn"]] = item
                except Exception:
                    continue
        print("检测到进度文件 %s，已完成 %d 首，继续续跑" % (part_path, len(done)))

    pending = [r for r in rows if r[1] not in done]
    t0 = time.time()
    written = 0
    with open(part_path, "a", encoding="utf-8") as pf:
        for start in range(0, len(pending), args.batch):
            chunk = pending[start:start + args.batch]
            texts = [build_text(r, args.text_format) for r in chunk]
            vecs = None
            last_err = None
            for attempt in range(4):
                try:
                    vecs = embed_batch(texts, args)
                    break
                except urllib.error.HTTPError as e:
                    last_err = "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:160])
                    if e.code in (400, 401, 403):
                        raise SystemExit("请求被拒绝，请检查 Key/模型/权限：%s" % last_err)
                except Exception as e:  # 网络抖动等，退避重试
                    last_err = repr(e)
                time.sleep(1.5 * (attempt + 1))
            if vecs is None:
                print("[skip] 批次 %d 连续失败：%s" % (start, last_err))
                continue
            for row, vec in zip(chunk, vecs):
                if len(vec) != args.dims:
                    raise SystemExit("维度不符：模型返回 %d 维，期望 %d 维（--dims）" % (len(vec), args.dims))
                item = {"fn": row[1], "voc": "no", "dur": round(float(row[5]), 1),
                        "v": quantize_int8(vec)}
                pf.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
                written += 1
            pf.flush()
            done_total = len(done) + written
            speed = done_total / max(1e-6, time.time() - t0)
            print("进度 %d/%d（%.1f 首/秒）" % (done_total, len(rows), speed))
            time.sleep(args.sleep)

    # 进度文件整体重读一次（后写覆盖前写），再按原始曲目顺序输出，保证与旧索引可比
    merged = {}
    with open(part_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue
            merged[item["fn"]] = item
    order = {r[1]: i for i, r in enumerate(rows)}
    final = sorted(merged.values(), key=lambda i: order.get(i["fn"], 1 << 30))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(final, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(args.out) / 1048576
    vocal = sum(1 for i in final if i.get("voc") == "yes")
    print("\n=== 完成 ===")
    print("曲目数：%d（其中标记有人声 %d）" % (len(final), vocal))
    print("向量维度：%d（字节/条：%d）" % (args.dims, len(base64.b64decode(final[0]["v"])) if final else 0))
    print("输出：%s（%.2f MB）" % (args.out, size_mb))
    print("进度文件可保留用于增量更新，若要重建请删除：%s" % part_path)


if __name__ == "__main__":
    main()
