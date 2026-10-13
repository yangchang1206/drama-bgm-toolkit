#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
内联 JS 语法校验：防止 web/index.html 这类「单文件前端」出现解析期语法错误。

为什么需要：HTML 里的 <script> 一旦有 SyntaxError，浏览器会**整段脚本不执行**，
表现为「按钮全部无响应 / 索引不加载」，且没有任何报错弹窗，极难定位。
本项目曾因此让整个前端失效（单行残留字符 `+n`），所以把校验固化成工具。

用法：
    python tools/check_inline_js.py web/index.html
    python tools/check_inline_js.py web/index.html --node "C:\\path\\to\\node.exe"

退出码：0 = 通过，1 = 有语法错误（可接入 CI / pre-commit）。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S | re.I)


def find_node(explicit=None):
    if explicit:
        return explicit
    for name in ("node", "node.exe"):
        found = shutil.which(name)
        if found:
            return found
    # WorkBuddy 受管运行时兜底
    fallback = r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
    if os.path.isfile(fallback):
        return fallback
    return None


def check_file(path, node):
    if not os.path.isfile(path):
        print("✗ 文件不存在：%s" % path)
        return 1
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    blocks = SCRIPT_RE.findall(html)
    if not blocks:
        print("· %s：没有内联脚本，跳过" % path)
        return 0

    failures = 0
    tmpdir = tempfile.mkdtemp(prefix="inlinejs_")
    for i, code in enumerate(blocks, 1):
        tmp = os.path.join(tmpdir, "block%d.js" % i)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(code)
        proc = subprocess.run([node, "--check", tmp], capture_output=True, text=True)
        if proc.returncode == 0:
            print("✓ %s：内联脚本 #%d（%d 字符）语法正常" % (path, i, len(code)))
        else:
            failures += 1
            print("✗ %s：内联脚本 #%d 存在语法错误" % (path, i))
            for line in (proc.stderr or "").strip().splitlines()[:12]:
                print("    " + line)
    shutil.rmtree(tmpdir, ignore_errors=True)
    return 1 if failures else 0


def main():
    ap = argparse.ArgumentParser(description="校验 HTML 内联 JS 的语法")
    ap.add_argument("files", nargs="+", help="一个或多个 HTML 文件")
    ap.add_argument("--node", default=None, help="node 可执行文件路径（默认自动查找）")
    args = ap.parse_args()

    node = find_node(args.node)
    if not node:
        print("✗ 找不到 node，无法做语法校验。请安装 Node.js 或用 --node 指定路径")
        return 2
    rc = 0
    for path in args.files:
        rc |= check_file(path, node)
    return rc


if __name__ == "__main__":
    sys.exit(main())
