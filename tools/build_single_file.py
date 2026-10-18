#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_single_file.py —— 把纯前端 BGM 工作台打包成「单文件 HTML」

背景
----
web/index.html 靠 fetch 加载 web_embeddings.json（约 7.8MB 的向量索引）。
在 file:// 协议下浏览器禁止 fetch 本地文件（CORS: origin 'null'），
所以必须额外起一个本地 HTTP 服务器 —— 这正是「要装 Python / 想打 exe」的根源。

但 <script> 标签在 file:// 下**不受 CORS 限制**。把索引写成
    <script>window.__EMB__ = [...];</script>
内联进 HTML，即可得到「双击即用、零安装、零服务器」的单文件版本。

注意：这只解决「索引加载」。选曲仍需联网调 DashScope
（text-embedding-v3 把情绪文案编码成 1024 维查询向量），exe 也改变不了这一点。

用法
----
# 方式 1：单文件（推荐，双击即用）
python tools/build_single_file.py \
    --html web/index.html \
    --emb  web_embeddings.json \
    --out  "BGM工作台-单文件.html"

# 方式 2：旁挂（index.html + embeddings.js 两个文件，包体更小、改代码方便）
python tools/build_single_file.py --mode sidecar \
    --html web/index.html \
    --emb  web_embeddings.json \
    --out  "BGM工作台-离线版.html"

输出
----
- inline 模式：一个自包含 HTML，内联索引 + 给 loadEmb() 注入「优先用内置索引」分支。
- sidecar 模式：输出 <out> 与同目录的 embeddings.js（<script src> 加载，同样绕开 CORS）。
"""

import argparse
import json
import os
import re
import sys

# loadEmb() 的开头，作为注入锚点
LOADEMB_ANCHOR = 'async function loadEmb() {\n  var rb = document.getElementById("readyBar");\n'

# 注入到 loadEmb() 最前面的「优先用内置索引」分支
INLINE_GUARD = '''async function loadEmb() {
  var rb = document.getElementById("readyBar");
  if (window.__EMB__ && window.__EMB__.length) {
    try {
      var p0 = getVec(window.__EMB__[0]);
      if (p0) {
        EMB = window.__EMB__;
        EMB_DIM = atob(p0).length;
        var inst0 = EMB.filter(function(e){return !vocIsVocal(e.voc);}).length;
        if (EMB_DIM !== 1024) {
          rb.innerHTML = "\\u26a0\\ufe0f <b>\\u5185\\u7f6e\\u7d22\\u5f15\\u7ef4\\u5ea6\\u4e0d\\u5339\\u914d</b>\\uff1a" + EMB_DIM +
            " \\u7ef4\\uff0c\\u800c\\u67e5\\u8be2\\u7528\\u7684\\u662f 1024 \\u7ef4\\u3002\\u8bf7\\u7528 tools/build_web_index.py \\u91cd\\u5efa\\u540e\\u91cd\\u65b0\\u6253\\u5305\\u3002";
          rb.style.background = "#fee2e2"; rb.style.color = "#991b1b";
          return;
        }
        rb.innerHTML = "\\u2705 <b>\\u5c31\\u7eea\\uff08\\u5185\\u7f6e\\u7d22\\u5f15\\uff09</b>\\uff1a\\u5171" + EMB.length +
          " \\u9996\\uff0c\\u7eaf\\u5668\\u4e50" + inst0 + " \\u9996\\uff08" + EMB_DIM + "\\u7ef4\\uff09";
        rb.style.background = "#dcfce7"; rb.style.color = "#15803d";
        return;
      }
    } catch (e) { console.warn("inline embeddings failed:", e.message); }
  }
'''


def to_js_literal(raw_json_text: str) -> str:
    """把 JSON 文本安全地内联成 JS 字面量。

    JSON 是 JavaScript 字面量的子集，可直接内联；只需处理两个坑：
      1) `</` 出现在字符串里会被 HTML 解析器误判为 </script> 结束标签
         → 转义为 `<\\/`（JSON 中 \\/ 是 / 的合法转义）
      2) U+2028 / U+2029 在 JSON 字符串里合法，但在 JS 里是换行符，会破坏语法
         → 转义为 \\u2028 / \\u2029
    这两种字符只可能出现在 JSON 字符串内部（< 与 U+2028 都不是 JSON 结构字符）。
    """
    text = raw_json_text.replace("</", "<\\/")
    text = text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return text


def load_html(path: str) -> str:
    with open(path, "r", encoding="utf-8", newline="") as f:
        html = f.read()
    # 统一成 LF，避免 CRLF 干扰锚点匹配
    return html.replace("\r\n", "\n").replace("\r", "\n")


def patch_load_emb(html: str) -> str:
    if LOADEMB_ANCHOR not in html:
        raise SystemExit(
            "[FAIL] 未找到 loadEmb() 锚点，无法注入内置索引分支。\n"
            "       请确认 --html 指向未改造过的 web/index.html。"
        )
    return html.replace(LOADEMB_ANCHOR, INLINE_GUARD, 1)


# lamejs 的 <script src> 标签（jsdelivr CDN）——单文件/桌面版要把它换成内联
LAME_TAG_RE = re.compile(r'<script[^>]*src="[^"]*lamejs[^"]*"[^>]*>\s*</script>\s*', re.IGNORECASE)


def inline_lamejs(html: str, lamejs_path: str) -> str:
    """把 CDN 上的 lamejs 换成内联副本（离线也能导出 MP3）。

    为什么必须内联：单文件版的定位是「双击即用、离线可用」，而 MP3 编码靠 lamejs；
    原来它从 jsdelivr CDN 加载 ⇒ 断网/CDN 被墙时，导 MP3 必失败（WAV 不受影响，因为是自己写的编码器）。
    WAV 路径完全不依赖它，所以内联只影响体积（+156 KB），不改变任何行为。
    """
    with open(lamejs_path, "r", encoding="utf-8") as f:
        code = f.read()
    if "Mp3Encoder" not in code:
        raise SystemExit(f"[FAIL] {lamejs_path} 里找不到 Mp3Encoder，可能下错了文件（要 lame.min.js）。")
    # 代码里若出现 </script 会被 HTML 解析器当成脚本结束标签（<\/script 在 JS 字符串里等价）
    code = code.replace("</script", "<\\/script")
    m = LAME_TAG_RE.search(html)
    if not m:
        raise SystemExit("[FAIL] 未找到 lamejs 的 <script src> 标签，无法替换为内联版本。\n"
                         "       源文件是否已被改过？（脚本要求 --html 指向未改造过的 web/index.html）")
    inline_tag = (
        '<script id="lamejsInline">\n'
        '/* lamejs 1.2.1 内联副本：原为 <script src> 指向 jsdelivr CDN，断网即无法导出 MP3。\n'
        '   由 tools/build_single_file.py --lamejs 注入，勿手改（要改请改 vendor/lame.min.js）。 */\n'
        f'{code}\n'
        '</script>\n'
    )
    return html[:m.start()] + inline_tag + html[m.end():]


def inject_data_script(html: str, data_script: str) -> str:
    """把数据 <script> 插到「主脚本」之前（保证 loadEmb() 调用时已就绪）。"""
    key = "var EMB = [], SONG_MAP = {}, OUT_DIR = null;"
    pos = html.find(key)
    if pos < 0:
        raise SystemExit("[FAIL] 未找到主脚本中的全局状态声明，无法定位注入点。")
    open_pos = html.rfind("<script", 0, pos)
    if open_pos < 0:
        raise SystemExit("[FAIL] 主脚本 <script> 标签定位失败。")
    return html[:open_pos] + data_script + "\n" + html[open_pos:]


def main() -> int:
    ap = argparse.ArgumentParser(description="将纯前端 BGM 工作台打包为单文件 HTML")
    ap.add_argument("--html", required=True, help="源 index.html 路径")
    ap.add_argument("--emb", required=True, help="web_embeddings.json 路径")
    ap.add_argument("--out", required=True, help="输出 HTML 路径")
    ap.add_argument("--mode", choices=["inline", "sidecar"], default="inline",
                    help="inline=索引内联进 HTML（单文件）；sidecar=另存 embeddings.js 并用 <script src> 引用")
    ap.add_argument("--sidecar-name", default="embeddings.js", help="sidecar 模式下的 JS 文件名")
    ap.add_argument("--lamejs", default=None,
                    help="lame.min.js 路径：给定时把它内联进产物（替代 CDN 的 <script src>），"
                         "断网也能导 MP3。推荐 vendor/lame.min.js")
    args = ap.parse_args()

    print("[1/4] 读取源文件 ...")
    html = load_html(args.html)
    if args.lamejs:
        html = inline_lamejs(html, args.lamejs)
        print(f"      lamejs     : 已内联（{os.path.getsize(args.lamejs):,} 字节，替代 CDN <script src>）")
    with open(args.emb, "r", encoding="utf-8") as f:
        raw_json = f.read()
    print(f"      index.html : {len(html):,} 字符")
    print(f"      embeddings : {len(raw_json):,} 字符（{len(raw_json)/1048576:.2f} MB）")

    # 先做基础校验：索引必须是合法 JSON 且含向量字段
    print("[2/4] 校验索引 ...")
    try:
        arr = json.loads(raw_json)
    except Exception as e:
        raise SystemExit(f"[FAIL] 索引不是合法 JSON：{e}")
    if not isinstance(arr, list) or not arr:
        raise SystemExit("[FAIL] 索引不是非空数组。")
    first = arr[0]
    vec = first.get("v") or first.get("q") or first.get("vec")
    if not vec:
        raise SystemExit("[FAIL] 索引首条缺少向量字段（v / q / vec）。")
    import base64
    dim = len(base64.b64decode(vec))
    print(f"      共 {len(arr):,} 条；首条向量 {dim} 维")
    if dim != 1024:
        print(f"      \u26a0\ufe0f  警告：{dim} 维 ≠ 1024 维，打包后前端会提示向量空间不匹配。")

    print("[3/4] 注入内置索引与加载分支 ...")
    js_literal = to_js_literal(raw_json)

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    os.makedirs(out_dir, exist_ok=True)

    if args.mode == "inline":
        data_script = ('<script id="embInline">\n'
                       '/* 内置向量索引：由 tools/build_single_file.py 生成，勿手改 */\n'
                       f'window.__EMB__ = {js_literal};\n'
                       '</script>')
        out_html = inject_data_script(patch_load_emb(html), data_script)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(out_html)
        extra = ""
    else:  # sidecar
        js_path = os.path.join(out_dir, args.sidecar_name)
        with open(js_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("/* 内置向量索引：由 tools/build_single_file.py 生成，勿手改 */\n")
            f.write(f"window.__EMB__ = {js_literal};\n")
        # <script src> 在 file:// 下不受 CORS 限制
        data_script = f'<script src="{args.sidecar_name}"></script>'
        out_html = inject_data_script(patch_load_emb(html), data_script)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(out_html)
        extra = f"\n      伴生文件 : {js_path}（{os.path.getsize(js_path)/1048576:.2f} MB）"

    size = os.path.getsize(args.out)
    print("[4/4] 完成 ✓")
    print(f"      输出     : {args.out}（{size:,} 字节 / {size/1048576:.2f} MB）{extra}")
    note = "双击即可用，无需本地服务器；选曲仍需联网 + DashScope API Key。"
    if args.lamejs:
        note += " lamejs 已内联 ⇒ 断网也能导 MP3（WAV 本来就不依赖）。"
    print(f"      说明     : {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
