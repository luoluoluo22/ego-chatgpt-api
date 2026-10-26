@echo off
chcp 65001 >nul
title Ego ChatGPT API Bridge
powershell -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
pause
