@echo off
cd /d "%~dp0"
title BGM Toolkit - Build Database

echo ============================================
echo   BGM Toolkit - One-click Build Database
echo ============================================
echo.

echo [1/3] Check Python 3.13...
py -3.13 --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing Python 3.13...
    py install 3.13
)
py -3.13 --version
echo.

echo [2/3] Installing dependencies...
py -3.13 -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
py -3.13 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    echo [ERROR] pip install failed.
    pause
    exit /b 1
)

echo.
echo [3/3] Building database (30-60 min)...
py -3.13 build_db.py
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Done!
echo ============================================
pause
