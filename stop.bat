@echo off
chcp 65001 >nul
title Stop Ego ChatGPT API Bridge
powershell -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1"
pause
