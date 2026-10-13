---
name: bgm-leitmotif-for-short-drama
version: 4.0.0
description: |
  AI短剧纯器乐BGM制作SKILL。按Leitmotif（主导动机）法，跟着主角内心情绪选曲，
  多段素材裁剪拼接成匹配视频时长的纯器乐BGM，输出MP3。
  适用于AI真人短剧、微短剧、剧情类视频的配乐制作。
author: doubao
license: MIT
---

# 短剧 BGM 配乐 SKILL v3.0（分享版）

> 为 AI 真人短剧逐集制作纯器乐 BGM 的标准工作流。基于实战经验沉淀。

---

## 一、适用场景与硬约束

用户给出：某一集的剧本 + 粗剪视频路径 + BGM 导出目录 + 素材库目录。

要求按剧情节奏和**主角内心情绪**，用多段素材剪切拼接成一首匹配视频时长的纯器乐 BGM，输出 MP3。

**硬约束（不可违反）**：

* 纯器乐，无人声、无吟唱、无动作音效
* 素材只从用户指定素材库选取
* BGM 总时长匹配视频实际时长（±0.5 秒）
* **crossfade 必须是叠加拼接**：两段音频在时间上重叠同时播放（一段渐弱、一段渐强），**不是首尾相接拼在一条线上**
* 段间交叉 2 秒，等功率曲线（cos/sin）
* 开头淡入 2 秒，结尾淡出 2 秒
* **能量归一化**：crossfade 前各段 RMS 拉到相近水平，否则切换处"突然消失"
* **人声过滤**：只选确认无人声的素材，有人声的一律不用

---

## 二、核心原则：Leitmotif 人物主题法（跟着主角走）

### 什么是 Leitmotif（主导动机）
瓦格纳发明、约翰·威廉姆斯《星球大战》发扬光大的电影配乐方法：
- **主角有专属音乐主题**：不是按场景配，是按主角配
- 观众听到这个旋律就知道"这是主角的时刻"
- **同一主题随剧情变奏**：主角开心时大调快奏、委屈时小调慢奏、反击时高奏
- **主角主题贯穿全片**：即使镜头在拍反派，BGM 也是主角的主题在紧张变奏
- **反派有对比主题**：和主角主题形成听觉反差

### 错误做法一：按场景类型选曲
- "对峙场景" → 选对峙音乐
- "温馨场景" → 选温馨音乐
- "热闹场景" → 选热闹音乐

### 错误做法二：按当前镜头在拍谁选曲
- 镜头拍反派 → 配反派的情绪
- 镜头拍主角 → 配主角的情绪
- 镜头拍配角 → 配配角的情绪

**这仍然是错的。** BGM 不是跟着镜头走，是跟着**主角**走。

### 正确做法
**全程跟着主角走**：
1. 先读剧本前几集，确定谁是主角（通常是女主）
2. 不管镜头在拍谁，BGM 都在表达**主角此刻的内心**
3. 主角隐忍时，即使反派在嚣张，BGM 也是主角的隐忍主题
4. 主角反击时，BGM 是主角主题从隐忍变奏成碾压
5. 主角委屈时，BGM 是主角主题的慢版小调变奏

### 举例（主角=女主）

| 段 | 场景 | 镜头在拍谁 | 女主的内心 | BGM 选曲方向 |
|----|------|-----------|------------|------------|
| 签到台 | 长辈夸男主 | 男主 | **在场但隐忍**（她知道真相） | 主角主题低能量铺垫版 |
| 喜棚内 | 女配嘲讽→女主反击 | 女配→女主 | **从隐忍到碾压**（手握证据） | 主角主题从低能量渐升到高能量 |
| 喜棚外 | 女配告状→男主进场 | 女配→男主 | **冷静旁观**（她不怕） | 主角主题紧张变奏中高能量 |

### Leitmotif 变奏规则
同一个主角，不同情绪状态用不同变奏：

| 主角情绪 | 变奏方向 | 音乐特征 |
|---------|---------|---------|
| 隐忍 / 平静 / 暗流 | 低能量版 | 小调、慢板、稀疏配器 |
| 坚定 / 决心 | 中能量推进版 | 小调转大调、节奏渐强 |
| 反击 / 碾压 / 爆发 | 全奏版 | 大调、高能量、管弦乐齐奏 |
| 委屈 / 悲伤 | 慢版小调 | 慢速、钢琴+弦乐 |
| 温暖 / 释然 | 大调明亮版 | 大调、木管、温暖音色 |

---

## 三、标准工作流（5 大阶段）

### 阶段 1：读剧本，定主角情绪弧线

通读剧本，输出：

1. **确定主角**：这一集（以及整部剧）的主角是谁（通常是女主）
2. **分场表**：每一场的时间、地点、人物
3. **主角情绪弧线表**：每一段主角内心什么情绪变化（不管镜头在拍谁）
4. **预估段数**：典型 3-5 段，每段 20-40 秒
5. **交叉点预判**：主角情绪转换的地方（隐忍→坚定、坚定→爆发、爆发→释然）

**输出示例（主角=女主）**：
```
段1（签到台）：女主在场隐忍 → 主角主题低能量铺垫版
段2（喜棚内）：女主从隐忍到碾压 → 主角主题从低能量渐升到高能量
段3（喜棚外）：女主冷静旁观 → 主角主题紧张变奏中高能量
```

### 阶段 2：分析视频，拿真实时间戳

并行跑 3 个工具（需要 mediakit-cli 或同等能力的视频处理工具）：

```bash
# 1. 探测时长
mediakit-cli video probe-video-metadata --video-url "<视频路径>"

# 2. 场景切分（画面硬切点）
mediakit-cli video segment-scenes --video-url "<视频路径>" --return-segment-videos=false --min-duration=2 --max-duration=40

# 3. 语音转字幕（人声时间轴）
mediakit-cli video asr-subtitles --video-url "<视频路径>" --language=cmn-Hans-CN --enable-speaker-info=true
```

返回 task_id 后轮询 `mediakit-cli shared query-task --task-id <id>` 拿结果。

**交叉点对齐**：
* 对齐 ASR 中关键台词结束时刻（情绪转换点）
* 对齐场景切分硬切点
* 不在台词中间切
* 段长按视频实际时长分配，不是按剧本字数猜

### 阶段 3：从素材库选曲

#### 3.0 优先用 CLAP 语义搜索（推荐）

如果素材库已经建了 CLAP embedding 数据库（SQLite），直接用自然语言按情绪搜曲，
比按 BPM/调性 表格筛选快 10 倍，且匹配更准。

**数据库结构**：`music_db.sqlite`
- `songs` 表：filename, fullpath, bpm, key, mode, has_vocals, dup_role
- `clap_embeds` 表：song_id + embed BLOB（512维 float32）

**搜索命令**：
```bash
# 自然语言搜曲（英文 query 效果更好）
python clap_search.py "sad emotional piano solo, melancholic" --top 10 --no-vocal --dedup

# 紧张对峙
python clap_search.py "tense thriller suspense, danger approaching" --top 10 --no-vocal --dedup

# 温暖治愈
python clap_search.py "warm healing, peaceful, sentimental strings" --top 10 --no-vocal --dedup
```

**参数说明**：
* `--no-vocal`：只选无人声素材（必加）
* `--dedup`：去重（重复曲只留 primary 版本）
* `--top N`：返回前 N 首
* **query 建议用英文**：CLAP 模型训练数据以英文为主，中文 query 方向对但精度低
* **query 写法**：情绪 + 乐器 + 场景，如 "tense thriller, dark cinematic, suspense"
  而不是只写"紧张"

**已知效果**：
* "sad piano, melancholic" → 匹配到抒情钢琴、悲伤主题音乐 ✓
* "tense thriller, danger" → 匹配到 X-Ray Dog、影视紧张配乐 ✓
* "warm healing" → 匹配到温暖弦乐、治愈系配乐 ✓

#### 3.1 规则筛选（CLAP 不可用时 fallback）

**预生成素材索引（推荐）**：
用 librosa 或同等音频分析工具，对素材库跑一次批量分析，生成 CSV 索引：

| 列名 | 说明 |
|------|------|
| 分类 | 素材目录分类 |
| 文件名 | MP3 文件名 |
| BPM | 节拍 |
| 调性 | 调号 |
| 调式 | 大调/小调 |
| 平均能量 | RMS |
| 峰值能量 | Peak |
| 频谱质心Hz | 亮度 |
| 时长秒 | 总时长 |
| 情绪推断 | 暗沉/明亮/中性等 |
| 是否有人声 | 是/否/疑似 |

**人声过滤硬规则**：
* 只选 `是否有人声=否` 的素材
* `是否有人声=是` 或 `=疑似` 的一律不用
* 已知有人声的歌：流行歌、带"唱/歌/live/演唱会"关键词的

**筛选流程**：
1. 根据阶段 1 的情绪表，确定每段需要的 BPM 范围、调式、能量水平
2. 从 CSV 索引筛选候选，**必须过滤人声**
3. 从候选中选 1-2 首，跑 librosa 分析能量曲线确认截取位置

**主角情绪→音乐特征匹配表**：

| 主角情绪 | 变奏类型 | BPM | 调式 | RMS 能量 | 频谱质心 | 典型选曲方向 |
|---------|---------|-----|------|---------|---------|------------|
| 隐忍 / 平静 / 暗流 | 低能量铺垫 | 70-90 | 小调 | 低 | 暗沉 | 钢琴独奏、稀疏弦乐 |
| 坚定 / 决心 / 推进 | 中能量渐强 | 90-110 | 小调转大调 | 中 | 中亮 | 弦乐推进、节奏渐强 |
| 反击 / 碾压 / 爆发 | 全奏高潮 | 100-130 | 大调 | 高 | 明亮 | 管弦乐齐奏、铜管 |
| 委屈 / 悲伤 / 心酸 | 慢版小调 | 60-80 | 小调 | 低 | 暗沉 | 钢琴+弦乐、慢板 |
| 温暖 / 释然 / 治愈 | 大调明亮 | 80-100 | 大调 | 中 | 明亮 | 木管、温暖音色 |
| 霸气 / 反转 / 登场 | 全奏主题 | >120 | 大调 | 高 | 明亮 | 铜管齐鸣、史诗感 |
| 山雨欲来 / 危机 | 悬疑铺垫 | <90 | 小调 | 低 | 暗沉 | 低频嗡鸣、不协和音 |
| 愤怒 / 爆发 / 反击 | 高能量快奏 | >120 | 小调 | 高 | 中亮 | 密集鼓点、快速弦乐 |

### 阶段 4：librosa 确认截取位置

对候选素材跑能量曲线分析：

```python
import librosa, numpy as np, os

y, sr = librosa.load(mp3路径, sr=22050, mono=True, duration=90)
hop = int(sr / 5)
rms = librosa.feature.rms(y=y, frame_length=hop*2, hop_length=hop)[0]
mean_rms = np.mean(rms)
sec_rms = [float(np.mean(rms[i:i+5])) for i in range(0, len(rms), 5)]

# 标出每秒能量柱状图
for i, v in enumerate(sec_rms[:90]):
    bar = '#' * int(v / mean_rms * 10)
    print(f"  {i:3d}s: {v:.4f} {bar}")
```

**选截取位置规则**：
* 要"高潮/爆发" → 选高能量段（>均值1.3倍）
* 要"铺垫/引入" → 选低能量段
* 要"稳定推进" → 选能量平稳段
* **避开**前奏（0-10秒通常低能量）、明显重复、断裂、空拍
* **同一首 BGM 可多次截取不同片段**用在不同位置
* **截取位置不固定**：可以用开头、中间、高潮、结尾，按情绪需要选

**裁剪**：
```bash
mediakit-cli editing trim-audio --audio-url "<素材路径>" --start-time <秒> --end-time <秒> --format wav
```

返回 task_id → query-task 拿 audio_url → curl 下载为 segN.wav。

**段长计算**：
* N 段，段间交叉 overlap=2 秒
* 总目标时长 T（秒）
* 段长之和 = T + (N-1) * overlap
* 例：T=128, N=3, overlap=2 → 段长之和 = 128+4=132 秒

### 阶段 5：能量归一化 + crossfade 拼接

**关键：能量归一化**

为什么需要：
- 不同素材 RMS 差异可能 3-5 倍
- 小声段渐弱时本来就很小声，大声段渐强时还没完全起来
- 中间交叉点"真空"，听感"突然消失"

**crossfade.py 模板（含能量归一化）**：

```python
import wave, struct, os, math
import numpy as np

work = r"<工作目录>"
files = ["seg1.wav", "seg2.wav", "seg3.wav"]
overlap = 2.0
fade_in_first = 2.0
fade_out_last = 2.0
TARGET_RMS = 0.12  # 能量归一化目标

def read_wav(path):
    w = wave.open(path, 'rb')
    nch = w.getnchannels(); sw = w.getsampwidth(); fr = w.getframerate(); nf = w.getnframes()
    raw = w.readframes(nf); w.close()
    assert sw == 2
    samples = np.array(struct.unpack("<" + "h" * nch * nf, raw), dtype=np.float64) / 32768.0
    return fr, nch, samples

def write_wav(path, fr, nch, samples):
    w = wave.open(path, 'wb')
    w.setnchannels(nch); w.setsampwidth(2); w.setframerate(fr)
    s16 = np.clip(samples * 32768.0, -32768, 32767).astype(np.int16)
    w.writeframes(s16.tobytes()); w.close()

def eq_power_gain(progress, direction):
    t = max(0.0, min(1.0, progress)) * math.pi / 2.0
    return math.sin(t) if direction == 'in' else math.cos(t)

segs = [read_wav(os.path.join(work, f)) for f in files]
fr0, nch0 = segs[0][0], segs[0][1]
overlap_frames = int(overlap * fr0)
lens = [len(s) // nch0 for _, _, s in segs]

# 能量归一化：每首歌RMS调到TARGET_RMS
norm_segs = []
for fr, nch, samples in segs:
    rms = float(np.sqrt(np.mean(samples**2)))
    scale = TARGET_RMS / rms if rms > 0 else 1.0
    scale = min(scale, 3.0)  # 限制放大倍数防爆音
    norm_segs.append(samples * scale)
    print(f"seg RMS: {rms:.4f} -> scale={scale:.2f} -> {rms*scale:.4f}")

# 叠加拼接：段2在段1结束前overlap秒开始
starts = [0]
for i in range(1, len(norm_segs)):
    starts.append(starts[-1] + lens[i-1] - overlap_frames)
total_frames = starts[-1] + lens[-1]

out = np.zeros(total_frames * nch0, dtype=np.float64)

def mix_in(seg_samples, start_frame, fin_s=0, fout_s=0):
    slen = len(seg_samples) // nch0
    fin_frames = int(fin_s * fr0) if fin_s > 0 else 0
    fout_frames = int(fout_s * fr0) if fout_s > 0 else 0
    for fr in range(slen):
        gain = 1.0
        if fin_frames and fr < fin_frames:
            gain *= eq_power_gain(fr / fin_frames, 'in')
        if fout_frames and fr >= slen - fout_frames:
            gain *= eq_power_gain((slen - fr) / fout_frames, 'out')
        if gain <= 0.001:
            continue
        for c in range(nch0):
            out[(start_frame + fr) * nch0 + c] += seg_samples[fr * nch0 + c] * gain

mix_in(norm_segs[0], starts[0], fade_in_first, overlap)
for i in range(1, len(norm_segs)-1):
    mix_in(norm_segs[i], starts[i], overlap, overlap)
mix_in(norm_segs[-1], starts[-1], overlap, fade_out_last)

# 检查峰值，防爆音
peak = float(np.max(np.abs(out)))
print(f"peak before normalize: {peak:.4f}")
if peak > 0.95:
    out = out * (0.95 / peak)

write_wav(os.path.join(work, "crossfade_full.wav"), fr0, nch0, out)
print(f"total: {total_frames} = {total_frames/fr0:.2f}s")
```

**转 MP3 导出**：
```bash
mediakit-cli editing trim-audio --audio-url "<crossfade_full.wav路径>" --start-time 0 --end-time <总秒数> --format mp3
```

返回 audio_url → curl 下载到用户指定导出目录。

文件名格式：`第XX集_<剧情关键词>.mp3`

---

## 四、技术参数规范

| 参数 | 值 | 说明 |
|------|---|------|
| 段间交叉时长 | 2.0 秒 | 两段重叠同时播放，一弱一强 |
| 交叉曲线 | 等功率 cos/sin | 响度恒定，无凹陷 |
| 开头淡入 | 2.0 秒 | 全曲开头从 0 渐入 |
| 结尾淡出 | 2.0 秒 | 全曲结尾到 0 淡出 |
| 能量归一化目标 | RMS=0.12 | 各段拉到相近水平 |
| 放大倍数上限 | 3.0 倍 | 防止小声段放大后爆音 |
| 叠加后峰值上限 | 0.95 | 超过则整体衰减 |
| 音频格式 | 16bit PCM WAV → MP3 | 中间用 WAV，交付 MP3 |
| 采样率 | 素材原生 | 不做重采样 |

**为什么用等功率而不是线性**：
* 线性渐变：交叉中间点两段各 0.5，总能量 = 0.5，比单段低 3dB，听着有"凹陷"
* 等功率：g1=cos(πt/2), g2=sin(πt/2)，中间点各≈0.707，总能量 = 1.0，响度恒定

**为什么需要能量归一化**：
* 不同素材 RMS 差异 3-5 倍时，crossfade 中间"真空"
* 归一化后各段响度一致，切换处听感平滑

---

## 五、踩过的坑（必读）

1. **Cloud 异步任务**：mediakit-cli 所有视频/音频处理都是异步，返回 task_id 后必须 query-task 轮询
2. **URL 过期**：query-task 返回的 audio_url 有时效性，拿到后立即 curl 下载
3. **文件路径含中文和空格**：直接传给 CLI，不要加 mediakit:// 前缀
4. **WAV 必须 RIFF 头**：下载后读前 4 字节确认是 "RIFF"
5. **段长补偿**：改 overlap 后必须重新裁剪 WAV，不能只改参数
6. **交叉点对齐人声**：必须跑 ASR 拿真实台词时间轴，不靠剧本猜
7. **选截取位置**：用 librosa RMS 能量曲线选，不靠文件名猜
8. **PowerShell 内联 python -c**：带中文引号会语法错误，必须写 .py 文件再运行
9. **能量不匹配**：不同素材 RMS 差异大时，crossfade 中间"突然消失"，必须做能量归一化
10. **改 overlap 后时长变化**：overlap 从 2 秒改 3 秒，总时长会少 2 秒，必须重新分配段长
11. **叠加后爆音**：能量归一化后叠加峰值可能超过 1.0，必须检查峰值并整体衰减
12. **有人声的素材**：选曲前必须确认无人声，混入人声会破坏纯器乐听感

---

## 六、工作目录结构

每集建独立工作目录：

```
<临时工作目录>/bgm<集数>/
├── seg1.wav          # 第1段素材
├── seg2.wav          # 第2段素材
├── ...
├── analyze.py        # 能量分析脚本
├── crossfade.py      # 拼接脚本（含能量归一化）
└── crossfade_full.wav  # 拼接后WAV
```

---

## 七、版本

* v4.0 (2026-10-12)：CLAP 语义搜索集成
  * 新增：CLAP（Contrastive Language-Audio Pretraining）音频 embedding 全库索引
  * 自然语言搜曲：直接输入情绪描述（英文效果佳），返回余弦相似度 Top N
  * 模型：laion/clap-htsat-unfused，512维投影，CPU 推理
  * 数据库：SQLite + BLOB 存 embedding，断点续跑
  * 选曲效率从"按BPM/调性表翻"升级为"按情绪语义搜"
* v3.0 (2026-09-23)：Leitmotif 人物主题法 + 能量归一化 + 人声过滤
  * 核心更新：Leitmotif 人物主题法——全程跟着主角走，不是跟着镜头走
  * 主角有专属音乐主题，同一主题随剧情变奏（隐忍→坚定→爆发）
  * 新增：能量归一化（RMS 统一到 0.12），修复"突然消失"
  * 新增：人声过滤硬规则
  * 升级：情绪→音乐匹配表，改为 Leitmotif 变奏表
* v2.0 (2026-09-19)：完整版重构
* v1.0：初版 7 步工作流
