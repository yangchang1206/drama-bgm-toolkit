@echo off
cd /d "%~dp0"
title BGM Toolkit - Search

:loop
echo ============================================
echo   BGM Search (English query works best)
echo   Examples:
echo     tense thriller dark cinematic
echo     sad emotional piano melancholic
echo     warm healing strings family
echo   Type q to quit
echo ============================================
echo.
set /p q="Query> "
if /i "%q%"=="q" exit /b
if "%q%"=="" goto loop
echo.
py -3.13 clap_search.py "%q%" --no-vocal --dedup --top 10
echo.
goto loop
