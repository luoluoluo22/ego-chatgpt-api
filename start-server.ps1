# 启动 ChatGPT OpenAI 本地 API 桥接服务
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 启动 ChatGPT OpenAI 本地 API 桥接服务 " -ForegroundColor Cyan
Write-Host " 监听端口: 8765 (http://127.0.0.1:8765)   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$serverScript = "file:///" + (Join-Path $PSScriptRoot "server.mjs").Replace("\", "/")
$null | ego-browser nodejs -e "await import('$serverScript')"
