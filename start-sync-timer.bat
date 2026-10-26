@echo off
chcp 65001 >nul
title Ego ChatGPT API - 30分钟定时双向同步守护进程
cd /d "%~dp0"
echo ========================================================
echo  Ego ChatGPT API - 启动 30 分钟定时双向同步守护进程
echo ========================================================
echo.
echo 提示：如需临时立即同步，可随时双击运行 sync-now.bat
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0sync.ps1" -Daemon -IntervalMinutes 30
pause
