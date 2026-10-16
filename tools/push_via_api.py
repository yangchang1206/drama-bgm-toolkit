#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当本机代理把 git 的 CONNECT 打死（502）、但 api.github.com 仍可达时，用 GitHub API 建提交。

背景（2026-10-16 实测）：环境代理 127.0.0.1:5772 对 github.com:443 的 CONNECT 时通时不通，
git push 反复 `CONNECT tunnel failed, response 502`；而同一代理下 curl/python 访问
api.github.com 始终 200。于是绕开 git 传输层，直接用 REST 建 blob → tree → commit → 移动 ref。

⚠️ 这样推上去的提交 sha 与本地提交**不同**（tree 相同、父提交相同、时间戳不同）。
下次 git 通道恢复时用 `git pull --rebase`（补丁等价的提交会被自动丢弃）或
`git fetch && git reset --hard origin/main` 对齐即可。

用法：
  python tools/push_via_api.py --repo yangchang1206/drama-bgm-toolkit --branch main \
      --message-file .git/COMMIT_EDITMSG --files web/index.html tools/smoke_dom.js ...

凭据：优先环境变量 GITHUB_TOKEN，否则从 Git Credential Manager 现取（git credential fill）。
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.request

API = "https://api.github.com"


def get_token():
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok.strip()
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, encoding="utf-8",
    )
    for line in (p.stdout or "").splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("拿不到 GitHub 凭据：请设置 GITHUB_TOKEN，或确认 Git Credential Manager 已缓存")


def req(method, path, token, payload=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", "Bearer " + token)
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "bgm-toolkit-push-api")
    if data:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=60) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body.strip() else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message-file", required=True)
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    # 代理：环境里已有 http_proxy/https_proxy 就用它（实测可达 api.github.com）
    for k in ("http_proxy", "https_proxy"):
        if k in os.environ:
            urllib.request.getproxies = lambda: {"http": os.environ[k], "https": os.environ[k]}
            break

    token = get_token()
    msg = open(args.message_file, encoding="utf-8").read()

    base = req("GET", "/repos/%s/git/ref/heads/%s" % (args.repo, args.branch), token)
    base_sha = base["object"]["sha"]
    print("基线提交: " + base_sha[:7])

    entries = []
    for rel in args.files:
        p = os.path.join(args.root, rel)
        if not os.path.isfile(p):
            raise SystemExit("找不到文件: " + p)
        raw = open(p, "rb").read()
        blob = req("POST", "/repos/%s/git/blobs" % args.repo, token,
                   {"content": base64.b64encode(raw).decode("ascii"), "encoding": "base64"})
        print("  blob %-40s %7d 字节  %s" % (rel, len(raw), blob["sha"][:7]))
        entries.append({"path": rel.replace("\\", "/"), "mode": "100644", "type": "blob", "sha": blob["sha"]})

    tree = req("POST", "/repos/%s/git/trees" % args.repo, token,
               {"base_tree": base["object"]["sha"], "tree": entries})
    commit = req("POST", "/repos/%s/git/commits" % args.repo, token,
                 {"message": msg, "tree": tree["sha"], "parents": [base_sha]})
    req("PATCH", "/repos/%s/git/refs/heads/%s" % (args.repo, args.branch), token,
        {"sha": commit["sha"], "force": False})

    print("\n✓ 已推送: " + commit["sha"][:7] + "   " + msg.splitlines()[0])
    print("  ⚠️ 这个 sha 与本地提交不同（tree 相同）。网络恢复后执行：")
    print("     git fetch && git pull --rebase    （补丁等价的本地提交会被自动丢弃）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
