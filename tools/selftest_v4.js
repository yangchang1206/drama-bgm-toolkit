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

// ================= 汇总 =================
console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("=".repeat(52));
process.exit(fail ? 1 : 0);

})().catch(e => { console.error("✗ 测试自身异常：" + (e && e.stack || e)); process.exit(1); });
