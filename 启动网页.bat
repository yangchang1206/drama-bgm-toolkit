@echo off
cd /d "%~dp0"
title BGM Web UI
echo Installing gradio...
py -3.13 -m pip install gradio -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.
echo Starting web UI...
py -3.13 app.py
pause
