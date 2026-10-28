@echo off
chcp 65001 >nul
title Enable Ego ChatGPT API Autostart
powershell -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause
