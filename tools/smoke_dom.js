#!/usr/bin/env node
/**
 * 真浏览器冒烟测试（补 selftest 的盲区）。
 *
 * 为什么需要它：selftest_v4.js 跑在最小 DOM 桩里，能验算法、**验不了 DOM**。
 * 历史上就出现过"逻辑全绿、页面一打开整段脚本失效"的情况。
 * 这里用无头 Chrome 真开一次页面，然后：
 *   1. 收集 **未捕获异常 / console.error**（页面自身的问题）；
 *   2. 手工塞一份假分段数据，调 renderDetail() / renderSegList()，
 *      验证右侧详情面板（含"每首候选曲各自裁剪"的新控件）能正常渲染；
 *   3. 点一次候选曲的 ▶ 、改一次裁剪输入框，确认不抛错、状态写对了对象。
 *
 * 用法：
 *   node tools/smoke_dom.js <目标html绝对路径> [chrome路径]
 * 注意：必须加 --no-proxy-server 启动 Chrome，否则本机代理会把
 * file:// 也拦成 ERR_CONNECTION（见项目记忆里的踩坑记录）。
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const target = process.argv[2];
const CHROME = process.argv[3] || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!target) { console.error("用法: node tools/smoke_dom.js <html 绝对路径>"); process.exit(1); }
if (!fs.existsSync(target)) { console.error("✗ 找不到 " + target); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("✗ 找不到 Chrome: " + CHROME); process.exit(1); }

const PORT = 9223;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-chrome-"));
const fileUrl = "file:///" + target.replace(/\\/g, "/");

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--no-proxy-server",                       // 关键：否则 file:// 也会被代理拦掉
  "--user-data-dir=" + profile,
  "--remote-debugging-port=" + PORT,
  "--window-size=1600,1000",
  fileUrl,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

(async () => {
  let ws, id = 0, pending = new Map();
  const errors = [];
  try {
    // 等 CDP 起来 + 页面目标出现（--headless=new 只有加载真实 URL 才会建 page 目标）
    let pageTarget = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
        pageTarget = list.find((t) => t.type === "page" && t.url.startsWith("file:"));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) break;
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    if (!pageTarget) throw new Error("没等到页面目标（Chrome 可能没起来）");

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === "Runtime.exceptionThrown") {
        errors.push("未捕获异常: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        errors.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }
    };
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error("页面内异常: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result?.result?.value;
    };

    await send("Runtime.enable", {});
    await send("Page.enable", {});
    // 单文件版内联了 8MB 索引，解析要几秒 —— 不能靠 sleep 猜，轮询页面就绪
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = await evaluate("typeof STATE !== 'undefined' && !!document.getElementById('detail')"); } catch (e) { ready = false; }
      if (ready) break;
      await sleep(500);
    }
    if (!ready) throw new Error("页面脚本 30 秒内未就绪（内联脚本可能执行失败）");

    let pass = 0, fail = 0;
    const ok = (n, c, d) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d !== undefined ? "  → " + d : "")); } };

    console.log("【S1 页面自身无未捕获错误】");
    const title = await evaluate("document.title");
    ok("页面标题为 BGM工作台", /BGM工作台/.test(title || ""), title);

    console.log("【S2 真造一段分段数据，渲染 ③ 与 ④ 面板】");
    const built = await evaluate(`(function(){
      // 拦掉弹窗：无头下 alert() 会阻塞整页 JS，导致后面的求值永远不返回
      window.__alerts = [];
      window.alert = function (m) { window.__alerts.push(String(m)); };
      window.confirm = function () { return true; };   // 清空配乐记录会弹 confirm，同样会阻塞
      SHOTS = [];
      for (var i = 0; i < 6; i++) SHOTS.push({ i:i, t0:i*5, t1:i*5+5, dur:5, mood:"温暖治愈",
        moodVec:new Float32Array(1024), source:"剧本", ruleMood:"温暖治愈", ruleScore:1, eng:0.5,
        sceneId:"48-1", text:"测试", query:"warm piano" });
      STATE.duration = 30; VIDEO_DUR = 30;
      STATE.segments = [{
        id:"48-1·1", timeStart:0, timeEnd:15, dur:15, shotCount:3, asl:5, wantBpm:110, eng:0.5,
        mood:"温暖治愈", source:"剧本", query:"warm piano", shotIdx:[0,1,2], track:0,
        candidates:[{fn:"a.mp3",dur:120,bpm:100,eng:0.5,sim:0.7,score:0.8,fDur:1,fBpm:1,fEng:1},
                    {fn:"b.mp3",dur:90,bpm:120,eng:0.6,sim:0.6,score:0.7,fDur:1,fBpm:1,fEng:1}]
      }];
      STATE.cur = 0;
      var err = null;
      try { renderSegList(); renderDetail(); renderTimeline(); } catch(e){ err = e.message; }
      var segs = document.querySelectorAll("#segList .seg").length;
      var rows = document.querySelectorAll("#cands .song").length;
      return { err: err, segs: segs, rows: rows,
               hasCutBox: !!document.getElementById("st") && !!document.getElementById("dur"),
               curSong: (document.querySelector("#detail .song.sel")||{}).textContent || "" };
    })()`);
    ok("renderSegList/renderDetail/renderTimeline 无异常", !built.err, built.err);
    ok("③ 情绪弧线渲染出 1 个段", built.segs === 1, built.segs);
    ok("④ 详情面板渲染出 2 个候选曲", built.rows === 2, built.rows);
    ok("裁剪控件（起点/时长输入框）存在", built.hasCutBox === true);
    ok("顶部显示当前用的那首（含序号）", /\[0\]/.test(built.curSong), built.curSong.slice(0, 40));

    console.log("【S3 点第 2 首的 ▶ / 改裁剪框，写入的是那一首】");
    const interact = await evaluate(`(function(){
      var err = null, hint = "";
      try {
        var btns = document.querySelectorAll("#cands .mini-play");
        btns[1].click();                       // 触发选中第 2 首（播放会因无素材而失败，不阻塞这里）
      } catch(e){ err = e.message; }
      var s = STATE.segments[0];
      // 模拟用户改裁剪框
      var ein = document.getElementById("st"), din = document.getElementById("dur");
      var ui = { track: s.track, rows: document.querySelectorAll("#cands .song").length };
      if (ein && din) { ein.value = "7.5"; ein.oninput(); din.value = "12"; din.oninput(); }
      var c = s.candidates[s.track];
      return { err: err, ui: ui, cut: (c ? (c.srcStart + "/" + c.srcDur) : "-"),
               note: (document.getElementById("cutNote")||{}).textContent || "",
               badge: Array.prototype.filter.call(document.querySelectorAll("#cands .cut-badge"),
                        function(b){ return b.style.display !== "none"; }).length };
    })()`);
    ok("点击 ▶ 不抛错", !interact.err, interact.err);
    ok("点击后选中的是第 2 首", interact.ui.track === 1, interact.ui.track);
    ok("裁剪值写到了第 2 首自己身上（7.5/12）", interact.cut === "7.5/12", interact.cut);
    ok("裁剪提示文案更新", /手动裁剪/.test(interact.note), interact.note);
    ok("候选行标出该曲已被剪过", interact.badge >= 1, interact.badge);

    console.log("【S4 跨集去重控件（M9）】");
    const dedup = await evaluate(`(function(){
      var err = null, before = null, after = {}, info = "";
      try {
        var chk = document.getElementById("dedupChk");
        var row = document.getElementById("dedupRow");
        var btn = document.getElementById("clearHistBtn");
        before = { has: !!chk, checked: !!(chk && chk.checked), hasBtn: !!btn,
                   hasFn: typeof loadHistory === "function" && typeof historyPool === "function" };
        saveHistory({ "epA#100KB": { t: 1, fns: ["x.mp3", "y.mp3"] } });
        if (window.__dedupRefresh) window.__dedupRefresh();
        info = (document.getElementById("histInfo") || {}).textContent || "";
        btn.click();                                   // confirm 已 stub 成 true
        after.cleared = Object.keys(loadHistory()).length === 0;
        chk.checked = false; chk.onchange();
        after.offCls = String(row.className).indexOf("off") >= 0;
        var p = historyPool("epB", 4, 100);            // 关闭后不该排除任何曲目
        after.noHist = p.set.size === 0;
        chk.checked = true; chk.onchange();
      } catch (e) { err = e.message; }
      return { err: err, before: before, info: info, after: after };
    })()`);
    ok("去重控件齐全（复选框 + 清空按钮 + 三个函数）",
       dedup.before && dedup.before.has && dedup.before.hasBtn && dedup.before.hasFn, JSON.stringify(dedup.before));
    ok("默认勾选「跨集避免重复用曲」", dedup.before && dedup.before.checked === true);
    ok("记录计数文案随历史更新", /1 集/.test(dedup.info || ""), dedup.info);
    ok("点【清空配乐记录】后历史归零", dedup.after && dedup.after.cleared === true);
    ok("关掉开关时区块样式切换", dedup.after && dedup.after.offCls === true);
    ok("关掉开关后不再排除任何曲目", dedup.after && dedup.after.noHist === true);
    ok("控件交互全程无异常", !dedup.err, dedup.err);

    console.log("【S5 单曲导出（④ 面板按钮 + 候选行每行一个 💾）】");
    const solo = await evaluate(`(function(){
      var out = {};
      try {
        var s = STATE.segments[0];
        out.panelBtn = !!document.getElementById("segExportBtn");
        out.wired = typeof document.getElementById("segExportBtn").onclick === "function";
        out.rowBtns = document.querySelectorAll("#cands .mini-export").length;
        // 无头下没有曲库文件：把解码桩成一段 30s 素材，其余真跑（真拼接 + 真 WAV 打包）
        window.__oldDecode = decodeAudioFile;
        decodeAudioFile = function(){ return Promise.resolve(getCtx().createBuffer(1, Math.round(44100*30), 44100)); };
        // 拦掉真实下载动作，只留下 a.download 的文件名供断言
        window.__oldCreateURL = URL.createObjectURL;
        URL.createObjectURL = function(){ return "blob:smoke"; };
        window.__oldClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){ window.__dl = this.download; };
        EXPORT_FMT = "wav"; OUT_DIR = null;
        s.track = 0;                       // 先把选中拨回第 1 首，验证「导别的行不动选中」
        return exportOneSegment(s, 1).then(function(){
          return { panelBtn: out.panelBtn, wired: out.wired, rowBtns: out.rowBtns,
                   status: (document.getElementById("status")||{}).textContent || "",
                   track: s.track,
                   rowDisabled: document.getElementById("expbtn-1").disabled,
                   panelText: (document.getElementById("segExportBtn")||{}).textContent || "",
                   dl: window.__dl };
        }).catch(function(e){ return { err: e.message, panelBtn: out.panelBtn, wired: out.wired, rowBtns: out.rowBtns }; });
      } catch (e) { return { err: e.message, panelBtn: out.panelBtn, wired: out.wired, rowBtns: out.rowBtns }; }
    })()`);
    ok("④ 面板有「单独导出这首」按钮且已绑定", solo.panelBtn === true && solo.wired === true, JSON.stringify(solo).slice(0, 120));
    ok("每行候选曲各有一个 💾（2 首 → 2 个）", solo.rowBtns === 2, solo.rowBtns);
    ok("点行上 💾 真走通导出（真拼接 + 真打 WAV）", !solo.err && /单曲导出 \[1\] b\.mp3/.test(solo.status || ""), solo.err || (solo.status || "").split("\n")[0]);
    ok("用的是那一首自己的裁剪（12s）", /时长 12\.\d\ds/.test(solo.status || ""), (solo.status || "").split("\n")[2]);
    ok("导出不改用户选中（仍停在 [0]）", solo.track === 0, solo.track);
    ok("文件名 = BGM_seg<段号>_<曲名>.wav", /BGM_seg48-1·1_b\.wav/.test(solo.status || ""), (solo.status || "").split("\n")[1]);
    ok("导出后按钮恢复可用、面板文案还原", solo.rowDisabled === false && /单独导出这首/.test(solo.panelText || ""), solo.rowDisabled + " / " + solo.panelText);
    ok("触发的是下载动作且文件名正确", /^BGM_seg.*_b\.wav$/.test(solo.dl || ""), solo.dl);

    console.log("【S6 MP3 导出（lamejs 编码器）】");
    const mp3 = await evaluate(`(function(){
      try {
        var s = STATE.segments[0];
        EXPORT_FMT = "mp3";
        return exportOneSegment(s, 0).then(function(){
          return { lame: (typeof lamejs === "function" && typeof lamejs.Mp3Encoder === "function"),
                   status: (document.getElementById("status")||{}).textContent || "",
                   dl: window.__dl };
        }).catch(function(e){ return { err: e.message, lame: (typeof lamejs) }; });
      } catch (e) { return { err: e.message, lame: (typeof lamejs) }; }
    })()`);
    ok("lamejs 可用（lamejs.Mp3Encoder 是函数）", mp3.lame === true, JSON.stringify(mp3).slice(0, 90));
    ok("MP3 导出真跑通（真编码不是走过场）", !mp3.err && /单曲导出 \[0\] a\.mp3/.test(mp3.status || ""), mp3.err || (mp3.status || "").split("\n")[0]);
    ok("落下的文件名是 .mp3", /\.mp3$/.test(mp3.dl || ""), mp3.dl);

    await sleep(300);
    console.log("\n" + "=".repeat(46));
    if (errors.length) { console.log("页面错误共 " + errors.length + " 条："); errors.slice(0, 8).forEach((e) => console.log("  ! " + e)); }
    else console.log("页面无未捕获错误");
    console.log("通过 " + pass + " 项，失败 " + fail + " 项" + (errors.length ? "，错误 " + errors.length + " 条" : ""));
    console.log("=".repeat(46));
    process.exitCode = (fail || errors.length) ? 1 : 0;
  } catch (e) {
    console.error("✗ 冒烟测试自身失败：" + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
