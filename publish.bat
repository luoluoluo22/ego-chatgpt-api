@echo off
chcp 65001 >nul
title Publish ego-chatgpt-api to Gitee & GitHub
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" -Message "%*"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] 发布过程中遇到错误，代码已终止。
    pause
)
