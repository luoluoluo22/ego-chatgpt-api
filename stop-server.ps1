# Safely stop the local Ego ChatGPT API listener without killing a shared Ego NodeService process.
$ErrorActionPreference = "Continue"
$port = 8765
$uri = "http://127.0.0.1:$port/shutdown"

Write-Host "Requesting graceful shutdown of the Ego ChatGPT API..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri $uri -Method Post -TimeoutSec 5 -UseBasicParsing
    Write-Host "Shutdown endpoint response: HTTP $([int]$response.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "Graceful shutdown endpoint was unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
}

$deadline = (Get-Date).AddSeconds(8)
do {
    Start-Sleep -Milliseconds 400
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        Write-Host "API listener on port $port has stopped." -ForegroundColor Green
        exit 0
    }
} while ((Get-Date) -lt $deadline)

Write-Host "Port $port is still listening. For safety, no process was force-killed because Ego may host the listener inside a shared NodeService process." -ForegroundColor Red
Write-Host "Inspect the project server session or restart Ego gracefully, then retry." -ForegroundColor Yellow
exit 1