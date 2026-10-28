@echo off
chcp 65001 >nul
title Disable Ego ChatGPT API Autostart
powershell -ExecutionPolicy Bypass -File "%~dp0uninstall-autostart.ps1"
pause
