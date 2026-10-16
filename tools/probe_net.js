#!/usr/bin/env node
/**
 * 浏览器侧网络探针 —— 专治「点击测试显示 ❌ Failed to fetch」。
 *
 * 背景：`Failed to fetch` 是 fetch() 抛的 TypeError，**不带任何原因**。
 * 真正的原因（CORS 预检被拒 / 混合内容被拦 / DNS 解析失败）只存在于
 * DevTools 的 console 里，而页面代码把它吞成了一个字符串。
 * 本探针用无头 Chrome 真发一次请求，把 CDP 的 Network.loadingFailed
 * （blockedReason + corsErrorStatus）与 Log.entryAdded 原样打出来。
 *
 * 用法：
 *   PROBE_KEY=sk-xxx node tools/probe_net.js [pageUrl]
 *   pageUrl 省略时用内置的 file:// 空页（origin=null，等价于本地双击打开单文件版）
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = process.env.PROBE_KEY || "";
const CHROME = process.env.PROBE_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9226;

// 每次探针要试的目标：name 只用于打印，url 是**最终**要打的地址
const PROBES = JSON.parse(process.env.PROBE_URLS || JSON.stringify([
  { name: "官方(兼容模式) /v1/embeddings", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings" },
]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "probe-chrome-"));
  // 空页：不加载索引，只为提供一个真实 origin
  const blank = path.join(profile, "blank.html");
  fs.writeFileSync(blank, "<!doctype html><title>probe</title><body>probe</body>", "utf8");

  const pageUrl = process.argv[2] || "file:///" + blank.replace(/\\/g, "/");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-proxy-server",                    // 关键：否则本机代理会拦截并伪装成网络失败
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + PORT,
    "--window-size=1200,800",
    pageUrl,
  ], { stdio: "ignore" });

  let ws, id = 0;
  const pending = new Map();
  const failures = [], logs = [];
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
        target = list.find((t) => t.type === "page");
        if (target && target.webSocketDebuggerUrl) break;
      } catch (e) { /* 未就绪 */ }
      await sleep(250);
    }
    if (!target) throw new Error("没等到页面目标");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Network.loadingFailed") {
        const p = m.params || {};
        failures.push({ reqId: p.requestId, err: p.errorText, blocked: p.blockedReason,
                        cors: p.corsErrorStatus && p.corsErrorStatus.corsError, type: p.type });
      }
      if (m.method === "Network.requestWillBeSent" && /dashscope|aliyuncs|api\./.test((m.params||{}).url||"")) {
        failures.push({ marker: "REQ", url: m.params.url });
      }
      if (m.method === "Log.entryAdded") {
        const e = m.params.entry || {};
        logs.push(e.source + "/" + e.level + ": " + String(e.text || "").slice(0, 400));
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        logs.push("console.error: " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400));
      }
    };
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return r.result;
    };

    await send("Runtime.enable", {});
    await send("Network.enable", {});
    await send("Log.enable", {});
    await sleep(400);

    const origin = (await evaluate("location.origin")).result.value;
    console.log("页面 origin = " + origin + "　（file:// 的 origin 显示为 null）\n");

    for (const p of PROBES) {
      failures.length = 0; logs.length = 0;
      const expr = `(async function(){
        try {
          var r = await fetch(${JSON.stringify(p.url)}, {
            method: "POST",
            headers: { "Authorization": "Bearer ${KEY}", "Content-Type": "application/json" },
            body: JSON.stringify({ model: "text-embedding-v3", input: ["test"], dimensions: 1024, encoding_format: "float" })
          });
          var t = await r.text();
          return { ok: r.ok, status: r.status, body: t.slice(0, 300) };
        } catch (e) { return { threw: e.name + ": " + e.message }; }
      })()`;
      const r = await evaluate(expr);
      console.log("── " + p.name);
      console.log("   URL: " + p.url);
      if (r.exceptionDetails) { console.log("   ✗ 求值异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300)); continue; }
      console.log("   结果: " + JSON.stringify(r.result && r.result.value));
      for (const f of failures) {
        if (f.marker === "REQ") console.log("   → 已发出: " + f.url);
        else console.log("   ✗ 加载失败: err=" + f.err + " blockedReason=" + (f.blocked || "-") +
                          " corsError=" + (f.cors || "-") + (f.type ? " type=" + f.type : ""));
      }
      for (const l of logs) if (/cors|CORS|blocked|insecure|Mixed|refused|ERR_/i.test(l)) console.log("   ! " + l);
      console.log("");
    }
  } catch (e) {
    console.error("✗ 探针自身失败：" + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
