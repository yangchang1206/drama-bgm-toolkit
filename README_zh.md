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

## 目录结构

```
├── config.py           # ★只改这个
├── build_db.py         # 一键建库
├── clap_search.py      # 自然语言搜曲
├── requirements.txt
├── README.md           # 英文说明
├── README_zh.md        # 本文件
├── SKILL.md            # 完整方法论
└── scripts/
    └── crossfade.py    # 拼接模板
```
