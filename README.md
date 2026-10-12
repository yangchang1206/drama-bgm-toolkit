# drama-bgm-toolkit

AI short-drama instrumental BGM toolkit. Leitmotif-based scoring + CLAP semantic music search + local vocal filtering + crossfade stacking.

Point it at your music folder, build a local database, then search by emotion and export episode BGM as MP3.

## Quick start (3 steps)

### 1. Install Python 3.13 + dependencies
```bash
pip install -r requirements.txt
# CPU torch (use a mirror in China)
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

### 2. Set your music folder
Edit `config.py`:
```python
MUSIC_ROOT = r"D:\YourMusicFolder"
```

### 3. Build database
```bash
python build_db.py
```
First run: ~30-60 min (scan + audio analysis + CLAP embeddings + voice detection).
Incremental updates after that. Outputs `music_db.sqlite`.

## Search music by emotion
```bash
# Tense / thriller
python clap_search.py "tense thriller dark cinematic suspense" --no-vocal --dedup --top 10

# Sad piano
python clap_search.py "sad emotional piano solo melancholic" --no-vocal --dedup --top 10

# Warm strings
python clap_search.py "warm healing strings heartfelt family" --no-vocal --dedup --top 10
```
English queries work best (CLAP is trained mainly on English).

## Trim & crossfade
1. Trim selected tracks to WAV:
```bash
ffmpeg -ss 20 -t 32 -i "selected.mp3" -ar 44100 -ac 1 seg1.wav
```
2. Set `WORK_DIR` and `FILES` in `scripts/crossfade.py` and run:
```bash
python scripts/crossfade.py
```
3. Export MP3:
```bash
ffmpeg -i crossfade_full.wav -codec:a libmp3lame -b:a 192k episode.mp3
```

## Core rules

1. Score the protagonist's inner emotion, not the scene label. Follow the lead character across cuts, even when the camera is on the antagonist.
2. Instrumental only. Always add `--no-vocal`.
3. Crossfade is *overlap* (two tracks play simultaneously, one fading out, one fading in), not concatenation. 2s overlap, equal-power cos/sin curves. 2s fade-in/out at ends.
4. Energy normalization: RMS is normalized per segment to ~0.12 before stacking, otherwise transitions sound like they "disappear".
5. Clip position is not fixed. Use intro, middle, climax, or outro of a track depending on the emotion needed. The same track may be clipped in multiple places.

## Structure
```
├── config.py           # ★ only file you edit
├── build_db.py         # one-click DB builder
├── clap_search.py      # natural language search
├── requirements.txt
├── README.md
├── SKILL.md            # full methodology (Leitmotif, CLAP, crossfade)
└── scripts/
    └── crossfade.py     # stacking template
```

## China users
HuggingFace direct download times out by default. `config.py` sets mirror:
```python
HF_ENDPOINT = "https://hf-mirror.com"
```
