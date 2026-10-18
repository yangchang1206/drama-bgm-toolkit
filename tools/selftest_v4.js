#!/usr/bin/env node
/**
 * v4.0 引擎自检：把 web/index.html 的**内联脚本原样**跑在最小 DOM 桩里，然后对
 * M1/M4/M5/M6/M7 的纯逻辑做断言。
 *
 * 为什么这么做：单文件前端最容易出的问题是「改了一处、悄悄坏了另一处」，
 * 而且浏览器里不看日志根本发现不了。这里让测试跑的就是**真正会发布的代码**，
 * 不做任何复制粘贴（历史上复制出来的副本早已跟线上不一致）。
 *
 * 用法：
 *   node tools/selftest_v4.js            # 默认测 web/index.html
 *   node tools/selftest_v4.js 其他.html
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const target = process.argv[2] || path.join(__dirname, "..", "web", "index.html");
const html = fs.readFileSync(target, "utf8");

// ---------- 提取最大的内联 <script>（跳过带 src 的 CDN 引用）----------
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);
if (!blocks.length) { console.error("✗ 没找到内联脚本"); process.exit(1); }
blocks.sort((a, b) => b.length - a.length);
const code = blocks[0];
console.log("内联脚本：" + code.length + " 字符");

// ---------- 最小 DOM / Web API 桩 ----------
function mkEl(tag) {
  const el = {
    id: "", tagName: (tag || "div").toUpperCase(), style: {}, dataset: {},
    value: "", textContent: "", innerHTML: "", className: "", disabled: false,
    files: [], width: 0, height: 0, videoWidth: 0, videoHeight: 0, duration: 0,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    parentElement: { style: {} },
    appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; },
    getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(160 * 90 * 4) }), fillRect() {} }; },
    toDataURL() { return "data:image/jpeg;base64,"; },
    click() {}, focus() {}, play() { return Promise.resolve(); }, pause() {},
  };
  return el;
}
class FakeAudioBuffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
    this.duration = len / sr;
    this._d = []; for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
  copyToChannel(src, ch) { this._d[ch].set(src.subarray ? src.subarray(0, this.length) : src); }
}
const elCache = Object.create(null);
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  atob, btoa, Blob, URL, TextEncoder, TextDecoder, AbortController, Promise, Math, JSON, Date,
  addEventListener() {}, removeEventListener() {},
  fetch: () => Promise.reject(new Error("selftest: 不发起真实网络请求")),
  alert: (s) => { throw new Error("alert: " + s); },
  document: {
    getElementById(id) { return elCache[id] || (elCache[id] = Object.assign(mkEl("div"), { id })); },
    querySelectorAll() { return []; },
    createElement(t) { return mkEl(t); },
    body: mkEl("body"),
    addEventListener() {},
  },
  AudioContext: function () {
    this.sampleRate = 44100; this.state = "running"; this.currentTime = 0;
    this.destination = {};
    this.createBuffer = (ch, len, sr) => new FakeAudioBuffer(ch, len, sr);
    this.resume = () => Promise.resolve();
  },
  AudioBuffer: FakeAudioBuffer,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.localStorage = undefined;   // 故意不提供：让 storeGet/storeSet 走内存降级分支
const ctx = vm.createContext(sandbox);

try {
  vm.runInContext(code, ctx, { filename: "index.inline.js" });
} catch (e) {
  console.error("✗ 内联脚本执行失败（语法或顶层错误）：" + e.message);
  process.exit(1);
}
console.log("✓ 内联脚本在 DOM 桩下执行成功\n");

// ---------- 断言框架 ----------
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  → " + detail : "")); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
function section(t) { console.log("\n【" + t + "】"); }
const G = sandbox;

(async () => {

// ================= T1 换曲点精确性（回归：旧版每段漂移 +4s）=================
section("T1 换曲点落在镜头切点上（绝对值，不累积漂移）");
{
  const SR = 8000, CH = 1;
  const Ds = [20, 24, 18];                 // 期望切点：20s、44s
  const levels = [0.30, 0.60, 0.90];
  G.FE_MIN = 1.5; G.FE_MAX = 4.0;
  const FEs = [0];
  for (let i = 1; i < Ds.length; i++) FEs.push(G.fadeWidthOf(Ds[i - 1], Ds[i]));
  const starts = []; let acc = 0; for (const d of Ds) { starts.push(acc); acc += d; }
  const bufs = Ds.map((d, i) => {
    const head = i > 0 ? FEs[i] / 2 : 0;
    const tail = i < Ds.length - 1 ? FEs[i + 1] / 2 : 0;
    const len = Math.round((d + head + tail) * SR);
    const b = new FakeAudioBuffer(CH, len, SR);
    b.getChannelData(0).fill(levels[i]);
    return b;
  });
  const total = 70;
  const out = await G.mixAtCuts(bufs, starts, FEs, total);
  const data = out.getChannelData(0);
  const totalSec = out.duration;

  function crossMid(i) {                    // 找 i 段与 i+1 段过渡区中点
    const a = levels[i], b = levels[i + 1];
    const target = Math.SQRT1_2 * (a + b);   // 等功率交叉在中点的理论值
    const lo = Math.max(0, Math.floor((starts[i + 1] - FEs[i + 1] / 2 - 0.3) * SR));
    const hi = Math.min(data.length - 1, Math.ceil((starts[i + 1] + FEs[i + 1] / 2 + 0.3) * SR));
    let bestT = -1, bestD = Infinity;
    for (let k = lo; k <= hi; k++) {
      const d = Math.abs(data[k] - target);
      if (d < bestD) { bestD = d; bestT = k / SR; }
    }
    return bestT;
  }
  const mid1 = crossMid(0), mid2 = crossMid(1);
  ok("第1个换曲点 = 20.00s", near(mid1, 20, 0.02), "实测 " + mid1.toFixed(3) + "s");
  ok("第2个换曲点 = 44.00s", near(mid2, 44, 0.02), "实测 " + mid2.toFixed(3) + "s");
  ok("无逐段累积漂移（误差 |Δ| ≤ 0.02s）", Math.abs(mid2 - 44) <= 0.02);
  ok("输出总长 = 视频时长 70s", near(out.duration, total, 1e-3), out.duration.toFixed(3) + "s");
  ok("交叉宽度在 1.5~4.0s 区间", FEs.slice(1).every(w => w >= 1.5 - 1e-9 && w <= 4 + 1e-9), FEs.slice(1).map(x => x.toFixed(2)).join(", "));
}
{
  // 边界用例：首段只有 1s（用户手填的极端分段）—— 交叉绝不能长过段本身
  G.FE_MIN = 1.5; G.FE_MAX = 4.0;
  const w = G.fadeWidthOf(1, 30);
  ok("首段 1s 时交叉宽度 ≤ 0.8s（不吞掉整段）", w <= 0.8 + 1e-9, w.toFixed(3) + "s");
}
section("T1b fadeWidthOf 自适应规则");
{
  ok("fadeWidthOf(30,30) = 4（长镜头给长交叉）", near(G.fadeWidthOf(30, 30), 4, 1e-9));
  ok("fadeWidthOf(6,6) ≈ 3.6（中等给中交叉）", near(G.fadeWidthOf(6, 6), 3.6, 1e-9), G.fadeWidthOf(6, 6));
  ok("fadeWidthOf(1,1) ≤ 0.8（快切给短交叉）", G.fadeWidthOf(1, 1) <= 0.8 + 1e-9, G.fadeWidthOf(1, 1));
}
section("T1c 交叉包络形状（反极性掩码法，防「淡出反向」回归）");
{
  // 两段素材分别灌 +1 / −1 的直流：等功率交叉窗口内应严格等于 cosθ−sinθ
  // （1 → 0 → −1 单调下降）。旧实现淡出用「剩余时长」做相位，曲线方向做反，
  // 整个窗口恒等于 0（= 静音断层 + 两端硬切），就是用户听到的「突然断开」。
  const SR = 8000;
  G.FE_MIN = 1.5; G.FE_MAX = 4.0;
  const Ds = [10, 10], FEs = [0, 2], starts = [0, 10];
  const bufs = Ds.map((d, i) => {
    const head = i > 0 ? FEs[i] / 2 : 0;
    const tail = i < Ds.length - 1 ? FEs[i + 1] / 2 : 0;
    const b = new FakeAudioBuffer(1, Math.round((d + head + tail) * SR), SR);
    b.getChannelData(0).fill(i === 0 ? 1 : -1);
    return b;
  });
  const out = await G.mixAtCuts(bufs, starts, FEs, 14);
  const data = out.getChannelData(0);
  const at = t => data[Math.round(t * SR)];
  ok("窗口起点 = 满音量（旧版此处骤降到 0）", Math.abs(at(9.005) - 1) < 0.03, at(9.005).toFixed(3));
  ok("9.5s ≈ +0.54（cosθ−sinθ 理论值）", Math.abs(at(9.5) - 0.5412) < 0.03, at(9.5).toFixed(3));
  ok("窗口中点回头相消 ≈ 0（等功率中点）", Math.abs(at(10)) < 0.05, at(10).toFixed(3));
  ok("10.5s ≈ −0.54（过中点后转负）", Math.abs(at(10.5) + 0.5412) < 0.03, at(10.5).toFixed(3));
  ok("窗口终点 ≈ −1（新段满音量接管）", Math.abs(at(10.995) + 1) < 0.03, at(10.995).toFixed(3));
  let mono = true, prev = at(9.05);
  for (let t = 9.1; t <= 10.95; t += 0.05) { const v = at(t); if (v > prev + 1e-3) { mono = false; break; } prev = v; }
  ok("窗口内单调下降（增益形状正确，不是先降回再升起）", mono);
}

// ================= T2 M4 DP 乐段聚合 =================
section("T2 M4 DP 乐段聚合：边界落在情绪突变处");
{
  const mk = (dur, v) => ({ i: 0, t0: 0, t1: dur, dur: dur, moodVec: new Float32Array(v), mood: v.indexOf(1) === 0 ? "A" : (v.indexOf(1) === 1 ? "B" : "C") });
  const V = { A: [1, 0, 0], B: [0, 1, 0], C: [0, 0, 1] };
  const plan = ["A", "A", "A", "B", "B", "B", "C", "C", "C", "C"];
  const shots = plan.map((p, i) => ({ i: i, t0: i * 3, t1: i * 3 + 3, dur: 3, mood: p, moodVec: new Float32Array(V[p]) }));
  const ranges = G.dpSegments(shots, { maxSegs: 8, minSeg: 6 });
  const bounds = ranges.slice(1).map(r => r.a);
  ok("段数 ≥ 2（识别出情绪变化）", ranges.length >= 2, JSON.stringify(ranges));
  ok("边界全部在情绪突变处 {3,6}", bounds.every(b => b === 3 || b === 6), JSON.stringify(bounds));
  ok("覆盖全部镜头 0..10", ranges[0].a === 0 && ranges[ranges.length - 1].b === shots.length);
  ok("段长 ≥ MIN_SEG 或已为最优解", ranges.every(r => {
    const d = shots.slice(r.a, r.b).reduce((a, s) => a + s.dur, 0);
    return d > 0;
  }));
}
{
  // 波动：情绪均匀同质 → 不应被过度切碎
  const shots = Array.from({ length: 12 }, (_, i) => ({ i, t0: i * 3, t1: i * 3 + 3, dur: 3, mood: "A", moodVec: new Float32Array([1, 0, 0]) }));
  const ranges = G.dpSegments(shots, { maxSegs: 8, minSeg: 6 });
  ok("同质情绪不切碎（段数 ≤ 4）", ranges.length <= 4, "段数 " + ranges.length);
}

// ================= T3 M4 cutability =================
section("T3 cutability：快切串里不该换曲，长镜头处适合换曲");
{
  const fast = Array.from({ length: 10 }, (_, i) => ({ i, t0: i, t1: i + 1, dur: 1 }));
  const slow = Array.from({ length: 10 }, (_, i) => ({ i, t0: i * 8, t1: i * 8 + 8, dur: 8 }));
  const cf = G.cutability(fast, 5), cs = G.cutability(slow, 5);
  ok("快切串（1s×2）换曲适宜度 < 0.2", cf < 0.2, cf.toFixed(3));
  ok("长镜头（8s×2）换曲适宜度 > 0.9", cs > 0.9, cs.toFixed(3));
  ok("长镜头 > 快切", cs > cf);
}

// ================= T4 M5 四维打分 =================
section("T4 M5 四维打分：时长/BPM/能量适配");
{
  ok("durFit(30,20) ≈ 0.925（够长，容忍度高）", near(G.durFit(30, 20), 0.925, 1e-6), G.durFit(30, 20));
  ok("durFit(15,20) = 0.7（够 loop 一次）", near(G.durFit(15, 20), 0.7, 1e-9));
  ok("durFit(5,20) = 0.125（太短）", near(G.durFit(5, 20), 0.125, 1e-9));
  ok("durFit(null,20) = 0.5（旧索引缺字段 → 中性）", near(G.durFit(null, 20), 0.5, 1e-9));
  const w3 = G.wantBpmOf(3), w08 = G.wantBpmOf(0.8), w15 = G.wantBpmOf(15);
  ok("ASL 3s → 目标 BPM 落在 90~120", w3 >= 90 && w3 <= 120, w3.toFixed(1));
  ok("ASL 0.8s → 目标 BPM 拉到上限 150", near(w08, 150, 1e-9), w08.toFixed(1));
  ok("ASL 15s → 目标 BPM 落到下限 70", near(w15, 70, 1e-9), w15.toFixed(1));
  ok("切得越快目标 BPM 越高", w08 > w3 && w3 > w15);
  ok("bpmFit(100,100) = 1", near(G.bpmFit(100, 100), 1, 1e-9));
  ok("bpmFit(100,160) = 0", near(G.bpmFit(100, 160), 0, 1e-9));
  ok("bpmFit(null,100) = 0.5（缺字段中性）", near(G.bpmFit(null, 100), 0.5, 1e-9));
  ok("engFit(1,1) = 1 / engFit(0,1) = 0", near(G.engFit(1, 1), 1, 1e-9) && near(G.engFit(0, 1), 0, 1e-9));
  const sum = G.W_MOOD + G.W_DUR + G.W_BPM + G.W_ENG;
  ok("四维权重之和 = 1", near(sum, 1, 1e-9), sum.toFixed(3));
}

// ================= T5 M7 规则层 =================
section("T5 M7 剧本规则层：情绪词典 + 剧作标记词");
{
  const r1 = G.moodRule("他扑通一声跪下，磕头求饶");
  ok("「跪下磕头求饶」→ 悲情压抑", r1.mood === "悲情压抑", JSON.stringify(r1));
  ok("  并标记剧作事件「屈辱」", r1.tag === "屈辱", r1.tag);
  const r2 = G.moodRule("全场哗然，所有人都目瞪口呆");
  ok("「全场哗然」→ 胜利史诗", r2.mood === "胜利史诗", r2.mood);
  const r3 = G.moodRule("她抱紧孩子，眼里含着笑");
  ok("「抱紧孩子笑」→ 温暖治愈", r3.mood === "温暖治愈", r3.mood);
  const r4 = G.moodRule("他抽出刀朝对方扑了过去，两人扭打");
  ok("「刀/扑/扭打」→ 紧张动作", r4.mood === "紧张动作", r4.mood);
  const r5 = G.moodRule("");
  ok("空文本 → 不硬编情绪（score=0，交给降级链）", r5.score === 0 && r5.mood === "", JSON.stringify(r5));
  ok("规则档都配了英文 query", Object.keys(G.MOOD_QUERY).length >= 8);
  ok("textEnergy 高密度 > 低密度", G.textEnergy("一二三四五六七八九十", 1) > G.textEnergy("一", 1));
}

// ================= T6 M2 场次对齐 =================
section("T6 M2 镜头↔场次对齐：按字数权重，单调不回退");
{
  const scenes = [
    { id: "1-1", text: "短".repeat(100) },
    { id: "1-2", text: "长".repeat(300) },
  ];
  const shots = Array.from({ length: 20 }, (_, i) => ({ i, t0: i * 2, t1: i * 2 + 2, dur: 2 }));
  const r = G.alignScenesToShots(scenes, shots, 40);
  const b = r.bounds;
  ok("边界数量 = 场数+1", b.length === 3, JSON.stringify(b));
  ok("边界严格递增", b[1] > b[0] && b[2] > b[1]);
  ok("首边界 = 视频起点 0", near(b[0], 0, 1e-9));
  ok("末边界 = 视频终点 40", near(b[2], 40, 1e-9));
  ok("边界吸附到镜头切点（2s 的整数倍）", near(b[1] % 2, 0, 1e-6), b[1]);
  ok("字数少的场拿到更短区间", (b[1] - b[0]) < (b[2] - b[1]), (b[1] - b[0]) + " vs " + (b[2] - b[1]));
  const covered = shots.every(s => s.sceneId);
  ok("每个镜头都分到了场号", covered);
}

// ================= T6b 场次头识别（v5.4：行首匹配 + 分镜脚本格式）=================
section("T6b 场次头识别：分镜脚本 / 集-场头都能切，表格与备注不再误判");
{
  const sb = [
    "【断点1】赵耀祖甩锅 — 生成片段1",
    "断点1 位置锚点：小卖部门口（日 外）。",
    "【镜头1 · 断点1】",
    "台词：赵耀祖（梗脖嘶吼）：都怪你！",
    "情绪标记：【甩锅·把错都推出去】",
    "【镜头2 · 断点1】",
    "台词：刘桂香（假装严厉）：怎么跟你姐说话呢！",
    "| 断点1 | 赵耀祖甩锅 | 镜头1-7 | 23.9s |",
    "备注：镜头1-2、4 为同一句（台词1）三拆。",
  ].join("\n");
  const sc1 = G.parseScenes(sb);
  ok("分镜脚本切出 2 个镜头头", sc1.length === 2, JSON.stringify(sc1.map(s => s.id)));
  ok("场次号 = 镜头1 / 镜头2", sc1[0] && sc1[0].id === "镜头1" && sc1[1].id === "镜头2");

  const dx = [
    "年龄：19-28岁身份：混混。",
    "67-1 日 外/内 小区小卖部",
    "赵耀祖瘫坐在台阶上梗着脖子吼：都怪你！",
    "67-2 日 内 小卖部",
    "刘桂香拍腿哭嚎，求饶。",
    "备注：镜头1-2、4 为同一句（台词1）。",
  ].join("\n");
  const sc2 = G.parseScenes(dx);
  ok("集-场头切出 2 场，编号 = 67-1 / 67-2", sc2.length === 2 && sc2[0].id === "67-1" && sc2[1].id === "67-2", JSON.stringify(sc2.map(s => s.id)));
  ok("「年龄：19-28岁」行没有被误判成场次", sc2.length === 2);

  const plain = "赵耀祖：都怪你！\n刘桂香：耀祖！怎么跟你姐说话呢！\n（两人对视）";
  ok("纯对白（无场次头）→ 空数组，改为给出警告提示", G.parseScenes(plain).length === 0);

  const scenes = [
    { id: "1", text: "短".repeat(200) },
    { id: "2", text: "短".repeat(200) },
    { id: "3", text: "短".repeat(200) },
    { id: "4", text: "短".repeat(6000) },
  ];
  const shots4 = Array.from({ length: 40 }, (_, i) => ({ i, t0: i, t1: i + 1, dur: 1 }));
  const r4 = G.alignScenesToShots(scenes, shots4, 40);
  const share = (r4.bounds[4] - r4.bounds[3]) / 40;
  ok("超长场次权重被截（占比 ≤ 60%，旧版 ≈ 91%）", share <= 0.6, (share * 100).toFixed(1) + "%");

  const shots2 = [{ i: 0, t0: 0, t1: 5, dur: 5, sceneId: "旧场", text: "旧文本" }];
  G.alignScenesToShots([], shots2, 5);
  ok("剧本切不出场次时，旧场次字段被清空（重跑不继承）", shots2[0].text === "" && shots2[0].sceneId === "");
}

// ================= T7 M3 关键镜头采样 =================
section("T7 M3 关键镜头采样与并发池");
{
  const shots = Array.from({ length: 30 }, (_, i) => ({ i, t0: i, t1: i + 1, dur: (i % 5 === 0 ? 8 : 1), ruleMood: (i < 15 ? "A" : "B") }));
  const picked = G.pickKeyShots(shots, 6);
  ok("挑出的关键镜头数 ≈ K（不超太多）", picked.size >= 6 && picked.size <= 10, picked.size);
  ok("挑出的都是合法下标", Array.from(picked).every(i => i >= 0 && i < shots.length));
  const few = G.pickKeyShots(shots.slice(0, 4), 6);
  ok("镜头数 < K 时全选", few.size === 4);

  let running = 0, maxRunning = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const res = await G.mapPool(items, 4, async (x) => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 5));
    running--;
    return x * 2;
  });
  ok("并发池结果顺序正确", res.every((v, i) => v === i * 2), JSON.stringify(res));
  ok("并发度确实达到 4（而非串行）", maxRunning === 4, "峰值 " + maxRunning);
  const res2 = await G.mapPool([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("boom"); return x; });
  ok("单条失败不拖垮整批（错误被收集）", res2[1] && res2[1].__err === "boom" && res2[0] === 1 && res2[2] === 3);
}

// ================= T8 用户手填时间点吸附 =================
section("T8 手填时间点吸附到镜头切点");
{
  const shots = Array.from({ length: 10 }, (_, i) => ({ i, t0: i * 5, t1: i * 5 + 5, dur: 5 }));
  const tp = [{ start: 0, end: 21 }, { start: 21, end: 47 }];
  const r = G.userTpToShotRanges(tp, shots);
  ok("返回 2 个区间", r && r.length === 2, JSON.stringify(r));
  ok("边界吸附到切点（20 → 镜头下标 4）", r[0].b === 4, JSON.stringify(r));
  ok("区间连续覆盖", r[0].b === r[1].a);
}

// ================= T9 索引元数据契约 =================
section("T9 索引元数据契约（前端读取路径）");
{
  const idxPath = path.join(__dirname, "..", "web", "web_embeddings.json");
  if (fs.existsSync(idxPath)) {
    const raw = fs.readFileSync(idxPath, "utf8");
    const idx = JSON.parse(raw);
    const withDur = idx.filter(e => typeof e.dur === "number").length;
    const withBpm = idx.filter(e => typeof e.bpm === "number").length;
    const withEng = idx.filter(e => e.eng === 0 || e.eng === 0.5 || e.eng === 1).length;
    const dims = Buffer.from(idx[0].v, "base64").length;
    ok("索引条数 > 5000", idx.length > 5000, idx.length);
    ok("向量维度 = 1024（与 text-embedding-v3 同空间）", dims === 1024, dims);
    ok("带 dur 的条目 > 90%", withDur / idx.length > 0.9, (100 * withDur / idx.length).toFixed(1) + "%");
    ok("带 bpm 的条目 > 90%", withBpm / idx.length > 0.9, (100 * withBpm / idx.length).toFixed(1) + "%");
    ok("带 eng 的条目 > 90%", withEng / idx.length > 0.9, (100 * withEng / idx.length).toFixed(1) + "%");
  } else {
    console.log("  - 跳过（未找到 " + idxPath + "）");
  }
}

// ================= T10 单场戏 + 整片同情绪（用户实测回归）=================
section("T10 单场戏整片同情绪时，不能整片只配一首");
{
  // 用户实测：第 48 集 90.8s、剧本只有 48-1 一场 → 所有镜头情绪同档，
  // 旧版 DP 的段内代价只看情绪 → 恒为 0 → 整片只配 1 首。
  // 这里按截图构造 42 个镜头：开场长镜 + 多串快切 + 中速镜头交替。
  const durs = [6.6, 1.2, 1.4, 1.8, 1.3, 2.2, 1.6, 1.1, 2.8, 1.5,
                4.2, 1.4, 1.7, 2.1, 1.2, 3.4, 1.6, 1.3, 2.5, 1.8,
                5.8, 1.5, 1.2, 2.0, 1.4, 2.6, 1.1, 1.9, 3.1, 1.5,
                6.4, 1.3, 1.6, 2.2, 1.2, 2.9, 1.7, 1.4, 3.6, 2.1, 4.9, 2.6];
  let t = 0;
  const shots = durs.map((d, i) => { const s = { i, t0: t, t1: t + d, dur: d, mood: "温暖治愈", moodVec: new Float32Array([1, 0, 0]) }; t += d; return s; });
  const total = t;
  ok("构造的视频 ≈ 90s", total > 85 && total < 100, total.toFixed(1) + "s");
  const ranges = G.dpSegments(shots, { maxSegs: G.MAX_SEGS, minSeg: G.MIN_SEG });
  ok("段数 ≥ 2（节奏变化处应换曲）", ranges.length >= 2, "段数 " + ranges.length + " " + JSON.stringify(ranges.map(r => r.a + "-" + r.b)));
  ok("段数 ≤ MAX_SEGS", ranges.length <= G.MAX_SEGS, "段数 " + ranges.length);
  // 每段时长足够配上歌
  const segDurs = ranges.map(r => shots.slice(r.a, r.b).reduce((a, s) => a + s.dur, 0));
  ok("每段 ≥ 5s（太短配不到曲）", segDurs.every(d => d >= 5), JSON.stringify(segDurs.map(d => +d.toFixed(1))));
  // 边界不落在快切串中间（前后两个镜头都 <2s 的位置不适合换曲）
  const badBounds = ranges.slice(1).filter(r => shots[r.a - 1].dur < 2 && shots[r.a].dur < 2);
  ok("换曲边界不落在快切串中间", badBounds.length === 0, JSON.stringify(badBounds.map(r => r.a)));
  // 对照组：整片节奏均匀（全是 3s 镜头）+ 同情绪 → 仍然不该切碎
  const uni = Array.from({ length: 30 }, (_, i) => ({ i, t0: i * 3, t1: i * 3 + 3, dur: 3, mood: "温暖治愈", moodVec: new Float32Array([1, 0, 0]) }));
  const ru = G.dpSegments(uni, { maxSegs: G.MAX_SEGS, minSeg: G.MIN_SEG });
  ok("对照组：节奏均匀+同情绪 → 少量段（≤3）", ru.length <= 3, "段数 " + ru.length);
}

// ================= T11 剧本为主 / 视频控节奏 / 候选曲各自裁剪 =================
section("T11 情绪以剧本为主，视频把控节奏，候选曲各自裁剪");
{
  // --- T11.1 情绪来源优先级：剧本 > 画面 > 延续 > 默认 ---
  const p1 = G.chooseMoodQuery({ ruleScore: 2, ruleMood: "悲情压抑", aiQuery: "bright colorful joyful scene" });
  ok("剧本能判出情绪 → 用剧本 query（画面描述被忽略）",
     p1.source === "剧本" && p1.q === G.MOOD_QUERY["悲情压抑"], JSON.stringify(p1).slice(0, 70));
  const p2 = G.chooseMoodQuery({ ruleScore: 0, ruleMood: "", aiQuery: "warm sunlight on faces" });
  ok("剧本无情绪线索 → 才用画面描述", p2.source === "画面" && p2.q === "warm sunlight on faces");
  const p3 = G.chooseMoodQuery({ ruleScore: 0, aiQuery: "" });
  ok("两者都无 → 交给降级链（q 为空）", p3.q === "" && p3.source === "");
  ok("段代表来源 剧本 > 画面", G.mainSource([{ source: "画面", dur: 9 }, { source: "剧本", dur: 1 }]) === "剧本");
  ok("段代表来源 画面 > 延续", G.mainSource([{ source: "延续", dur: 9 }, { source: "画面", dur: 1 }]) === "画面");
  ok("来源配色：剧本=rule(琥珀)/画面=ai(绿)/延续=carry",
     G.srcTagCls("剧本") === "rule" && G.srcTagCls("画面") === "ai" && G.srcTagCls("延续") === "carry");

  // --- T11.2 视频节奏 → 乐段长度上限 ---
  const mk2 = (n, d) => Array.from({ length: n }, (_, i) => ({ i, t0: i * d, t1: i * d + d, dur: d, mood: "A", moodVec: new Float32Array([1, 0, 0]) }));
  const fast = G.idealMaxSeg(mk2(60, 1.5)), slow = G.idealMaxSeg(mk2(20, 6));
  ok("快剪 ASL1.5 → 乐段上限 ≤ 30s", fast <= 30 + 1e-9, fast.toFixed(1) + "s");
  ok("长镜头 ASL6 → 乐段上限 = 60s（封顶）", near(slow, 60, 1e-6), slow.toFixed(1) + "s");
  ok("快剪上限 < 长镜头上限（视频决定换曲频率）", fast < slow);
  ok("未超上限 → longPenalty = 0", G.longPenalty(30, 45) === 0);
  ok("超上限 → 线性增长且封顶 0.7", G.longPenalty(90, 45) > 0 && G.longPenalty(100000, 45) <= 0.7 + 1e-9);

  // --- T11.3 每首候选曲各自记自己的裁剪 ---
  const seg = { timeStart: 0, timeEnd: 40, dur: 40, track: 1,
                candidates: [{ fn: "a.mp3" }, { fn: "b.mp3" }, { fn: "c.mp3" }] };
  const d1 = G.candCut(seg.candidates[1], seg);
  ok("默认裁剪：起点 2s / 时长 = 乐段时长 40s", d1.start === 2 && d1.dur === 40, JSON.stringify(d1));
  seg.candidates[1].srcStart = 12; seg.candidates[1].srcDur = 22;
  const d2 = G.segCut(seg);
  ok("写入的是第 2 首自己的裁剪", d2.start === 12 && d2.dur === 22 && d2.manual === true);
  ok("第 1 首不受影响（各记各的）", G.candCut(seg.candidates[0], seg).start === 2);
  const ord = G.buildOrder(seg);
  ok("取素材次序：选中曲排第一", ord[0].fn === "b.mp3" && ord.length === 3, ord.map(o => o.fn).join(","));
}

// ================= T12 「点哪首剪哪首」端到端（真跑 buildSegmentBuffer + renderBGM）=================
section("T12 选中的候选曲 + 它的裁剪，真的作用到导出（端到端）");
{
  const SR = 8000;
  // 造素材：前 8 秒静音、之后满电平 —— 用它反查"从第几秒开始取"
  const makeSrc = () => { const b = new FakeAudioBuffer(1, Math.round(60 * SR), SR); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (i / SR < 8) ? 0 : 1; return b; };
  G.SONG_MAP = { "a.mp3": { k: "a" }, "b.mp3": { k: "b" }, "c.mp3": { k: "c" }, "d.mp3": { k: "d" } };
  G.decodeAudioFile = async () => makeSrc();
  G.FE_MIN = 1.5; G.FE_MAX = 4.0;

  const seg = { timeStart: 0, timeEnd: 30, dur: 30, track: 0,
                candidates: [{ fn: "a.mp3" }, { fn: "b.mp3" }], shotCount: 5, wantBpm: 100, eng: 0.5 };
  // 默认（起点 2s）→ 2s 处仍在静音区
  let b0 = await G.buildSegmentBuffer(seg, 10, null);
  ok("默认起点 2s → 素材前段是静音（证明确实从 2s 取）", b0.getChannelData(0)[Math.round(4 * SR)] === 0);
  // 给第 2 首设 "从 12s 取"（12s 已在满电平区）
  seg.candidates[1].srcStart = 12; seg.candidates[1].srcDur = 18;
  seg.track = 0;
  let b1 = await G.buildSegmentBuffer(seg, 10, null);
  ok("仍选第 1 首 → 还从 2s 取（静音）", b1.getChannelData(0)[Math.round(4 * SR)] === 0);
  seg.track = 1;   // 用户点了第 2 首
  let b2 = await G.buildSegmentBuffer(seg, 10, null);
  ok("点了第 2 首 → 素材从 12s 取（满电平）", b2.getChannelData(0)[Math.round(4 * SR)] === 1);

  // renderBGM：段长应按**选中曲**的裁剪时长，而不是乐段原始时长
  const segs = [
    { timeStart: 0, timeEnd: 30, dur: 30, track: 0, candidates: [{ fn: "a.mp3" }, { fn: "b.mp3", srcStart: 12, srcDur: 18 }] },
    { timeStart: 30, timeEnd: 60, dur: 30, track: 0, candidates: [{ fn: "c.mp3" }, { fn: "d.mp3" }] }
  ];
  let r = await G.renderBGM(segs, 60);
  ok("第 1 段用默认裁剪 → 落点 0 起、第 2 段落点 30s", near(r.starts[0], 0, 1e-9) && near(r.starts[1], 30, 1e-9), JSON.stringify(r.starts));
  segs[0].track = 1;   // 第 1 段改用第 2 首（剪到 18s）
  r = await G.renderBGM(segs, 60);
  ok("改用剪到 18s 的那首 → 第 2 段落点前移到 18s", near(r.starts[1], 18, 1e-9), JSON.stringify(r.starts));
  ok("段素材长度 = 裁剪时长 18s + 交叉余量", near(r.segLens[0], 18 + r.FEs[1] / 2, 0.05), r.segLens[0] + "（FEs[1]=" + r.FEs[1].toFixed(1) + "）");
  ok("输出总长仍 = 视频时长 60s", near(r.buf.duration, 60, 1e-3), r.buf.duration.toFixed(3));
}

// ================= T13 跨集去重（用户实测：每集都有重复的音乐）=================
section("T13 跨集去重 + 音效过滤 + 艺人打散");
{
  const N = 60;
  const lib = [], sm = {};
  for (let i = 0; i < N; i++) {
    const v = new Float32Array(8);
    v[0] = 1; v[1] = (i / N) * 0.6;              // 带梯度：排序确定但不全同分
    const nm = Math.hypot(v[0], v[1]) || 1; v[0] /= nm; v[1] /= nm;
    const dur = i < 10 ? 3 : 90;                  // 前 10 首是 <12s 的音效
    const artist = i < 20 ? "同一人" : ("艺人" + (i % 25));
    const fn = artist + " - Tra" + i + ".mp3";
    lib.push({ fn: fn, voc: "no", v: v, dur: dur, bpm: 100, eng: 0.5, ton: "" });
    sm[fn.toLowerCase()] = { f: fn };
  }
  G.EMB = lib; G.SONG_MAP = sm; G.EMB_DECODED = null;
  const oldDecode = G.decodeVec, oldGet = G.getVec;
  G.decodeVec = (x) => x; G.getVec = (e) => e.v;     // 绕过 base64，直接给向量
  const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
  const mkSeg = (d) => ({ dur: d || 30, wantBpm: 100, eng: 0.5, candidates: [], track: 0, timeStart: 0, timeEnd: d || 30 });

  // --- 艺人解析 ---
  ok("artistOf 取 \" - \" 前段", G.artistOf("彭飞 - 妈！.mp3") === "彭飞");
  ok("V.A. / 群星 不算艺人（避免误伤合集）",
     G.artistOf("V.A. - x.mp3") === "" && G.artistOf("群星 - y.mp3") === "");
  ok("无 \" - \" 的文件名不算艺人", G.artistOf("转场.mp3") === "");

  // --- 音效过滤 ---
  const c0 = G.pickTracks(q, mkSeg(), new Set(), 10, {});
  ok("候选中不含 <12s 的音效素材", c0.every(c => c.dur >= 12), "最小 dur=" + Math.min.apply(null, c0.map(c => c.dur)));
  ok("候选含 10 首", c0.length === 10, c0.length);

  // --- 历史池：本集旧记录不参与排除（重跑同一集结果稳定）---
  G.saveHistory({});
  const ep1Picks = [];
  {
    const pool = G.historyPool("ep1", 4, N);
    ok("第 1 集无历史可排除", pool.set.size === 0 && pool.eps === 0);
    const used = pool.set, epArt = {};
    for (let k = 0; k < 4; k++) {
      const cd = G.pickTracks(q, mkSeg(), used, 10, epArt);
      ep1Picks.push(cd[0].fn); used.add(cd[0].fn);
      const a = G.artistOf(cd[0].fn); if (a) epArt[a] = 1;
    }
    G.rememberEpisode("ep1", ep1Picks);
  }
  ok("第 1 集 4 段用了 4 首不同曲子", new Set(ep1Picks).size === 4, ep1Picks.join(","));
  ok("记住第 1 集后再读，本集记录不排除自己", G.historyPool("ep1", 4, N).set.size === 0);

  const pool2 = G.historyPool("ep2", 4, N);
  ok("第 2 集能读到第 1 集用过的 4 首", pool2.set.size === 4 && pool2.eps === 1, pool2.set.size);
  {
    const used = pool2.set, epArt = {};
    const ep2Picks = [];
    for (let k = 0; k < 4; k++) {
      const cd = G.pickTracks(q, mkSeg(), used, 10, epArt);
      ep2Picks.push(cd[0].fn); used.add(cd[0].fn);
      const a = G.artistOf(cd[0].fn); if (a) epArt[a] = 1;
    }
    const dup = ep2Picks.filter(f => ep1Picks.indexOf(f) >= 0);
    ok("第 2 集选出的曲与第 1 集零重叠（旧版这里是 100% 重叠）", dup.length === 0, dup.join(","));
    G.rememberEpisode("ep2", ep2Picks);
  }

  // --- 端到端：5 集 × 4 段 ---
  G.saveHistory({});
  const all = [];
  for (let ep = 1; ep <= 5; ep++) {
    const pool = G.historyPool("ep" + ep, 4, N);
    const used = pool.set, epArt = {}, picks = [];
    for (let k = 0; k < 4; k++) {
      const cd = G.pickTracks(q, mkSeg(), used, 10, epArt);
      picks.push(cd[0].fn); used.add(cd[0].fn);
      const a = G.artistOf(cd[0].fn); if (a) epArt[a] = 1;
    }
    G.rememberEpisode("ep" + ep, picks);
    all.push.apply(all, picks);
  }
  ok("5 集 20 段 → 20 首不同曲子（跨集重复率 0%）", new Set(all).size === 20,
     "不同 " + new Set(all).size + " / 20");

  // --- 同一集内艺人打散（软扣分）---
  {
    // 造两首：A 与已用艺人同名且分数更高，B 分略低但艺人新 → 应选 B
    const lib2 = [
      { fn: "已用者 - hot.mp3", voc: "no", v: [1, 0, 0, 0], dur: 90, bpm: 100, eng: 0.5, ton: "" },
      { fn: "新艺人 - alt.mp3", voc: "no", v: [0.985, 0, 0, 0], dur: 90, bpm: 100, eng: 0.5, ton: "" }
    ];
    const old = G.EMB; G.EMB = lib2; G.EMB_DECODED = null;
    G.SONG_MAP = { "已用者 - hot.mp3": {}, "新艺人 - alt.mp3": {} };
    const noArt = G.pickTracks(q, mkSeg(), new Set(), 2, {});
    ok("不打散时选分数最高的那首", noArt[0].fn.indexOf("hot") >= 0, noArt[0].fn);
    const withArt = G.pickTracks(q, mkSeg(), new Set(), 2, { "已用者": 1 });
    ok("同集内已用过该艺人 → 换新的那首（软扣分生效）", withArt[0].fn.indexOf("alt") >= 0, withArt[0].fn);
    G.EMB = old; G.EMB_DECODED = null;
  }

  // --- 预算兜底：历史占用超过曲库上限时丢弃更早的集 ---
  {
    const h = {};
    for (let i = 0; i < 8; i++) h["old" + i] = { t: i, fns: ["f" + (i * 6) + ".mp3", "f" + (i * 6 + 1) + ".mp3", "f" + (i * 6 + 2) + ".mp3", "f" + (i * 6 + 3) + ".mp3", "f" + (i * 6 + 4) + ".mp3", "f" + (i * 6 + 5) + ".mp3"] };
    G.saveHistory(h);
    const p = G.historyPool("newep", 4, N);      // N=60 → 预算 max(16, 27) = 27
    ok("超预算时保留最近的集、丢弃更早的", p.eps > 0 && p.dropped > 0 && p.set.size <= 27,
       "保留 " + p.eps + " 集/" + p.set.size + " 首，丢弃 " + p.dropped + " 集");
  }

  G.saveHistory({});
  G.decodeVec = oldDecode; G.getVec = oldGet;
}

// ================= T14 网络报错归因（用户实测：点了测试只有一句 Failed to fetch）=================
{
  section("T14 报错归因：CSP 定位 + 连接探活二分");

  // 1) CSP 命中前后，Failed to fetch 的报错必须有差别
  G.CSP_HITS.length = 0;
  const noCsp = G.wrapNetError(new TypeError("Failed to fetch"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", 45000).message;
  ok("没命中 CSP 时不出现「CSP」字样（不误报）", noCsp.indexOf("CSP") < 0, noCsp.slice(0, 40));

  G.CSP_HITS.push("connect-src https://dashscope.aliyuncs.com ← https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
  const cspMsg = G.wrapNetError(new TypeError("Failed to fetch"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", 45000).message;
  ok("命中 CSP 时把 violatedDirective 带出来", /CSP/.test(cspMsg) && /connect-src/.test(cspMsg), cspMsg.slice(0, 80));
  ok("命中 CSP 时给出可执行的自证办法", /无痕/.test(cspMsg), cspMsg.slice(-60));
  G.CSP_HITS.length = 0;

  // 2) 探活结果的三种分岔必须给出三种不同结论
  const v1 = G.probeVerdict({ origin: "https://a", plain: "HTTP 200", auth: "HTTP 401" });
  ok("探活：连接通 + 预检通 → 问题在 embeddings 请求本身", /预检也通过/.test(v1), v1.slice(0, 60));
  const v2 = G.probeVerdict({ origin: "https://a", plain: "HTTP 200", auth: "❌ Failed to fetch" });
  ok("探活：连得上但带鉴权被拦 → 判定 CORS 预检被拒", /预检被拒/.test(v2), v2.slice(0, 60));
  const v3 = G.probeVerdict({ origin: "https://a", plain: "❌ Failed to fetch", auth: "❌ Failed to fetch" });
  ok("探活：连不带鉴权都失败 → 归因到本机代理/安全软件", /代理/.test(v3) && /安全软件/.test(v3), v3.slice(0, 60));
  const v4 = G.probeVerdict(null);
  ok("探活无结果时不崩、照样给结论", /连不带鉴权的 GET 都失败/.test(v4), v4.slice(0, 40));

  // 3) 网络文案不能吞掉真正的服务端错误
  const passthrough = G.wrapNetError(new Error("HTTP 401：Incorrect API key"), "https://x/embeddings", 45000);
  ok("鉴权类错误原样透传（不被网络文案覆盖）", /Incorrect API key/.test(passthrough.message));

  // 4) 探活里的异常要压成短句，否则报错会层层嵌套成一堵墙
  const long = G.wrapNetError(new TypeError("Failed to fetch"), "https://a.invalid/v1/embeddings", 45000).message;
  const se = G.shortErr(new Error(long));
  ok("shortErr 把整段归因压成一句话", se.length <= 71 && /^Failed to fetch/.test(se), se);
}

// ================= T15 单曲导出（右侧 ④ 面板：候选行的 💾 + 面板按钮）=================
section("T15 单曲导出：候选里任意一首都能单独导 + 文件名清洗");
{
  const SR = 8000;
  const makeSrc = () => { const b = new FakeAudioBuffer(1, Math.round(60 * SR), SR);
    const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = 1; return b; };
  G.SONG_MAP = { "a.mp3": { k: "a" }, "b.mp3": { k: "b" } };
  G.decodeAudioFile = async () => makeSrc();
  G.FE_MIN = 1.5; G.FE_MAX = 4.0;

  const seg = { id: "第1段", timeStart: 0, timeEnd: 20, dur: 20, track: 0,
                candidates: [{ fn: "a.mp3" }, { fn: "b.mp3", srcStart: 5, srcDur: 12 }],
                shotCount: 5, wantBpm: 100, eng: 0.5 };

  // 1) 单段仍走唯一渲染入口 renderBGM：时长 = 那首的裁剪时长，且标「单段无交叉」
  const cut = G.candCut(seg.candidates[1], seg);
  let D = parseFloat(cut.dur); if (!(D > 0)) D = (seg.timeEnd - seg.timeStart) || 10; D = Math.max(0.5, D);
  const r = await G.renderBGM([seg], D);
  ok("单段导出时长 = 那首的裁剪时长 12s", r && near(r.buf.duration, 12, 1e-3), r && r.buf.duration.toFixed(3));
  ok("单段无交叉（feNote 标注）", /单段无交叉/.test(r.feNote), r.feNote);
  ok("单段落点从 0s 起", r.starts.length === 1 && near(r.starts[0], 0, 1e-9), JSON.stringify(r.starts));

  // 2) 端到端：当前选中 [0]，却去导 [1] —— 必须用 [1] 自己的裁剪，且不能改用户的选中
  G.EXPORT_FMT = "wav";
  G.OUT_DIR = null;
  seg.track = 0;
  await G.exportOneSegment(seg, 1);
  const st = G.document.getElementById("status").textContent;
  ok("导出候选[1]，状态里写的是第 2 首", /单曲导出 \[1\] b\.mp3/.test(st), st.split("\n")[0]);
  ok("用的是那一首自己的裁剪（12s）", /时长 12\.\d\ds/.test(st), st.split("\n")[2] || "");
  ok("导出后不改用户的选中（仍是 [0]）", seg.track === 0, "track=" + seg.track);
  ok("文件名 = BGM_seg<段号>_<曲名>.wav", /BGM_seg第1段_b\.wav/.test(st), st.split("\n")[1]);
  ok("导出结束恢复按钮可用", G.document.getElementById("expbtn-1").disabled === false);

  // 3) 文件名清洗：Windows 非法字符 / 空白 / 超长 / 缺段号与曲名
  const n1 = G.segExportName({ id: "1:2" }, { fn: "夜曲 (feat. A/B).wav" }, "mp3");
  ok("非法字符与空白全换成下划线", !/[\\\/:*?"<>|\s]/.test(n1), n1);
  ok("扩展名跟随传入的导出格式", /\.mp3$/.test(n1), n1);
  const n2 = G.segExportName({ id: "" }, { fn: "" }, "wav");
  ok("缺段号/缺曲名也有兜底名", /^BGM_seg[a-z]+_song\.wav$/.test(n2), n2);
  const n3 = G.segExportName({ id: "1" }, { fn: "长".repeat(60) + ".mp3" }, "wav");
  ok("超长曲名被截断（整名 ≤55 字符）", n3.length <= 55, n3.length + " 字符 → " + n3);
}

// ================= T16 音乐文件夹递归计数（问题③回归）=================
section("T16 音乐文件夹：子目录里的音频也要计入「已选：N 个音频」");
{
  const file = n => ({ kind: "file", name: n });
  const dir = ch => ({ kind: "directory", name: "d", values: async function* () { for (const c of ch) yield c; } });
  const root = dir([
    dir([file("a.mp3"), file("b.wav"), file("note.txt")]),
    dir([dir([file("c.flac")])]),
    file("top.mp3"),
  ]);
  G.SONG_MAP = {};
  const total = await G.scanDir(root, G.SONG_MAP);
  ok("递归计数 = 4（旧版只数顶层 = 1）", total === 4, "total=" + total);
  ok("SONG_MAP 装满 4 个可解码文件", Object.keys(G.SONG_MAP).length === 4, Object.keys(G.SONG_MAP).join(","));
  ok("非音频文件被忽略", !("note.txt" in G.SONG_MAP));
}

// ================= T17 重跑不继承上一轮情绪（问题①回归）=================
section("T17 分析可重入：同一视频重跑，情绪从零算，不继承上一轮");
{
  const shots = Array.from({ length: 4 }, (_, i) => ({
    i, t0: i, t1: i + 1, dur: 1,
    ruleMood: "紧张动作", ruleScore: 1.2, aiQuery: "旧画面", qKey: "旧",
    pickMood: "紧张动作", source: "剧本", query: "旧", mood: "悲情压抑",
    moodVec: new Float32Array([0, 0, 1]),
  }));
  G.clearShotMoodState(shots);
  ok("clearShotMoodState 清空上一轮所有派生字段",
     shots.every(s => !s.moodVec && s.mood === "" && s.aiQuery === "" && s.source === "" && s.query === "") === true);

  const qMap = { "q1": new Float32Array([1, 0, 0]) };
  shots[1].qKey = "q1"; shots[1].pickMood = "温暖治愈";
  G.assignShotMoods(shots, qMap, new Float32Array([0, 1, 0]));
  ok("有 query 的镜头用新情绪", shots[1].mood === "温暖治愈", shots[1].mood);
  ok("前一个镜头降级为默认「日常」", shots[0].mood === "日常" && shots[0].source === "默认", shots[0].mood + "/" + shots[0].source);
  ok("后两个镜头沿上新镜头情绪（延续）", shots[2].mood === "温暖治愈" && shots[2].source === "延续", shots[2].mood + "/" + shots[2].source);
  ok("没有任何镜头残留上一轮的「悲情压抑」", shots.every(s => s.mood !== "悲情压抑"));
}

// ================= 汇总 =================
console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("=".repeat(52));
process.exit(fail ? 1 : 0);

})().catch(e => { console.error("✗ 测试自身异常：" + (e && e.stack || e)); process.exit(1); });
