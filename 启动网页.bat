@echo off
cd /d "%~dp0"
title BGM Toolkit - Launcher

echo ============================================
echo   Which workbench do you want to open?
echo ============================================
echo   1 = Server workbench  (Gradio, app.py; needs Python + torch)
echo   2 = Browser workbench (web\index.html; needs a Chromium browser + Aliyun Key)
echo   3 = Just check the browser workbench's inline JS syntax
echo.
set /p choice="Enter 1/2/3 (default 1): "
if "%choice%"=="" set choice=1

if "%choice%"=="2" goto browser
if "%choice%"=="3" goto syntax

:server
echo.
echo [1/2] Installing gradio...
py -3.13 -m pip install gradio -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.
echo [2/2] Starting Gradio workbench (python app.py)...
py -3.13 app.py
pause
exit /b 0

:browser
echo.
echo Opening web\index.html in your default browser...
start "" "%~dp0web\index.html"
echo.
echo Note: the browser workbench needs
echo   1. a Chromium-based browser (Chrome / Edge)
echo   2. an Aliyun DashScope API Key
echo   3. web_embeddings.json (build it with tools\build_web_index.py)
pause
exit /b 0

:syntax
echo.
py -3.13 tools\check_inline_js.py web\index.html
pause
exit /b 0
