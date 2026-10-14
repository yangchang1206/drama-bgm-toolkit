# drama-bgm-toolkit（中文说明）

AI 短剧纯器乐 BGM 自动配乐工具包。基于 Leitmotif 人物主题法 + CLAP 语义搜曲 + 本地人声过滤 + crossfade 叠加拼接。

指定你的音乐文件夹路径，一键建库，按主角情绪搜曲，导出 MP3。

## 快速开始（3步）

### 1. 装依赖

需要 Python 3.10-3.13（推荐 3.13）。

```bash
pip install -r requirements.txt
# CPU 版 torch（国内加镜像）
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

### 2. 填你的音乐库路径

编辑 `config.py`：
```python
MUSIC_ROOT = r"D:\你的音乐文件夹"
```

### 3. 一键建库

```bash
python build_db.py
```

首次约 30-60 分钟（扫描+音频分析+CLAP embedding+人声检测），之后增量更新。完成后生成 `music_db.sqlite`。

## 搜曲

```bash
# 紧张悬疑
python clap_search.py "tense thriller dark cinematic suspense" --no-vocal --dedup --top 10

# 悲伤钢琴
python clap_search.py "sad emotional piano solo melancholic" --no-vocal --dedup --top 10

# 温暖治愈
python clap_search.py "warm healing strings heartfelt family" --no-vocal --dedup --top 10
```

**query 用英文效果更好**（CLAP 模型主要训练数据是英文）。写法：情绪 + 乐器 + 场景。

## 裁剪 + 拼接

1. 用 ffmpeg 裁成 WAV：
```bash
ffmpeg -ss 20 -t 32 -i "选中的歌.mp3" -ar 44100 -ac 1 seg1.wav
```
2. 改 `scripts/crossfade.py` 里的 `WORK_DIR` 和 `FILES`，运行：
```bash
python scripts/crossfade.py
```
3. 转 MP3：
```bash
ffmpeg -i crossfade_full.wav -codec:a libmp3lame -b:a 192k 第XX集.mp3
```

## 核心原则

1. **跟着主角内心情绪配，不跟场景标签配**。镜头在拍反派，BGM 也是主角的情绪。
2. **纯器乐无人声**。搜曲必加 `--no-vocal`。
3. **crossfade 是叠加拼接**：两段时间上重叠同时播放（一段渐弱、一段渐强），不是首尾相接。段间交叉 2 秒，等功率曲线。
4. **能量归一化**：不同曲子响度差 3-5 倍时，交叉点会"突然消失"，脚本自动把每段 RMS 拉到 0.12。
5. **截取位置不固定**：开头/中间/高潮/结尾都可用，同一首可在不同位置截取。

## 国内用户

HuggingFace 直连必超时，`config.py` 已默认设镜像：
```python
HF_ENDPOINT = "https://hf-mirror.com"
```

## 两个工作台（不要混淆）

| | 服务端工作台 | 浏览器工作台 |
|---|---|---|
| 入口 | `app.py`（Gradio） | `web/index.html`（单文件，双击打开） |
| 依赖 | Python + torch + ffmpeg | Chromium 系浏览器 + 阿里云 DashScope Key |
| 检索 | CLAP 音频向量（512 维，SQLite） | DashScope `text-embedding-v3`（1024 维，JSON 索引） |
| 适用 | 稳定批量生产、需要精确调试 | 非技术同学一键出片、无需装环境 |

两者共享方法论，但**向量空间与代码完全独立，索引不可互换**。

### 浏览器工作台首次使用

1. 用 Chromium 浏览器打开 `web/index.html`；
2. 填入阿里云 DashScope API Key（保存在浏览器 localStorage）；
3. 生成向量索引（**必须做，否则选曲全部落空**）：

```bash
set DASHSCOPE_API_KEY=sk-xxxx
python tools/build_web_index.py --db music_db.sqlite --out web/web_embeddings.json
```

4. 选音乐文件夹 → 匹配向量库 → 粘剧本 + 选视频 → 分析 → 导出。

### 索引格式契约（改动前端/索引时必须遵守）

`web_embeddings.json` 是数组，元素：

```json
{"fn": "曲名.mp3", "voc": "no", "dur": 194.1, "v": "<base64>"}
```

* `fn`：音频文件名，前端按**小写文件名**与本地文件对齐；
* `voc`：`"yes"`（有人声/疑似，前端会过滤）或 `"no"`；中文 `是/疑似` 也识别；
* `dur`：时长（秒），可选；
* `v`：base64(1024 字节)，**1 字节 = 1 维**，前端解码为 `(byte - 128) / 127`。

> 关键约束：索引向量必须与查询侧 `text-embedding-v3`（1024 维）**同一向量空间**。
> 索引维度不是 1024 时，前端会直接报「向量空间不匹配」并中止（不会静默返回空结果）。

## 开发守则

* **改完 `web/index.html` 必须做一次内联脚本语法校验**：

```bash
python tools/check_inline_js.py web/index.html
```

  HTML 里的 `<script>` 一旦有 SyntaxError，浏览器会整段不执行，表现为「按钮全部无响应」且无任何提示。
  本项目曾因单行残留字符（`+n`）让整个前端失效，故固化为工具，建议接入提交前检查。

## 目录结构

```
├── config.py                  # ★只改这个
├── build_db.py                # 一键建库（librosa + CLAP + VAD）
├── clap_search.py             # 自然语言搜曲（CLI）
├── app.py                     # 服务端工作台（Gradio）
├── requirements.txt
├── README.md                  # 英文说明
├── README_zh.md               # 本文件
├── SKILL.md                   # 完整方法论（Leitmotif 配乐法，必读）
├── 使用手册.md                 # 面向使用者的分步手册
├── 一键建库.bat / 搜曲.bat / 启动网页.bat
├── tools/
│   ├── build_web_index.py     # 生成浏览器工作台的向量索引
│   └── check_inline_js.py     # 内联 JS 语法校验
├── scripts/
│   └── crossfade.py           # 拼接模板（含能量归一化）
└── web/
    ├── index.html             # 浏览器工作台（单文件）
    ├── web_embeddings.json    # 向量索引（由 tools/build_web_index.py 生成）
    └── README.md
```

