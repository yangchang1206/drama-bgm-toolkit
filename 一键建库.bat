@echo off
cd /d "%~dp0"
title BGM Toolkit - Build Database

echo ============================================
echo   BGM Toolkit - One-click Build Database
echo ============================================
echo.

echo [1/4] Check Python 3.13...
where py >nul 2>&1
if errorlevel 1 goto nopy
py -3.13 --version >nul 2>&1
if errorlevel 1 goto nopy
py -3.13 --version
echo.

echo [2/4] Reminder: edit config.py (MUSIC_ROOT) before building.
echo       Current MUSIC_ROOT is printed by build_db.py below.
echo.

echo [3/4] Installing dependencies...
py -3.13 -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
py -3.13 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    echo [ERROR] pip install failed.
    pause
    exit /b 1
)

echo.
echo [4/4] Building database (30-60 min, resumable)...
py -3.13 build_db.py
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Done! Database: music_db.sqlite
echo.
echo   Next step (for the browser workbench):
echo     set DASHSCOPE_API_KEY=sk-xxxx
echo     py -3.13 tools\build_web_index.py --db music_db.sqlite --out web\web_embeddings.json
echo ============================================
pause
exit /b 0

:nopy
echo [ERROR] Python 3.13 with the Windows launcher (py) was not found.
echo         Install it with:  winget install Python.Python.3.13
echo         or download from https://www.python.org/downloads/
echo         (the previous version of this script called "py install 3.13",
echo          which is NOT a valid command - that is why it failed.)
pause
exit /b 1
