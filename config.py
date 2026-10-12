# -*- coding: utf-8 -*-
# ============================================
# ★ 用户只需修改这个文件 ★
# ============================================

# Your music root folder (subfolders are scanned recursively)
# Example Windows paths:
#   MUSIC_ROOT = r"D:\MyMusic"
#   MUSIC_ROOT = r"D:\Assets\BGM"
MUSIC_ROOT = r"D:\MyMusic"

# Database output location (default: next to this script)
import os
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "music_db.sqlite")

# HuggingFace mirror (required in China, otherwise CLAP download times out)
HF_ENDPOINT = "https://hf-mirror.com"

# CLAP model (usually no need to change)
CLAP_MODEL = "laion/clap-htsat-unfused"

# Voice detection: speech ratio above this threshold = has vocals
VOICE_THRESHOLD_RATIO = 0.02  # 2%

# Sample rate
SAMPLE_RATE = 16000

# Supported audio extensions
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
