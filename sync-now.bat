@echo off
chcp 65001 >nul
title Ego ChatGPT API - 即刻同步
cd /d "%~dp0"
echo ========================================================
echo  Ego ChatGPT API - 立即执行 Git 双向同步
echo ========================================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0sync.ps1" -Now
echo.
pause
