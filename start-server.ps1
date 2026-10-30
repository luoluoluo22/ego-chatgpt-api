# Optional local settings. Keep .env out of Git and never share it.
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $eq = $line.IndexOf("=")
            if ($eq -gt 0) {
                $name = $line.Substring(0, $eq).Trim()
                $value = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
                if ($name -match "^(EGO_API_KEY|EGO_API_PORT|EGO_MAX_BODY_BYTES|EGO_MAX_QUEUE_LENGTH|EGO_API_LOG_FILE|EGO_PROVIDERS|EGO_TASK_SPACE_ID|EGO_SUNO_TASK_SPACE_ID|EGO_SUNO_URL)$") {
                    [Environment]::SetEnvironmentVariable($name, $value, "Process")
                }
            }
        }
    }
}
# Start Ego ChatGPT API Service
$ErrorActionPreference = "Stop"

$port = if ($env:EGO_API_PORT) { [int]$env:EGO_API_PORT } else { 8765 }
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "==========================================" -ForegroundColor Yellow
    Write-Host " Ego ChatGPT API listener is already running on port $port." -ForegroundColor Yellow
    Write-Host " Opening management dashboard: http://127.0.0.1:$port ..." -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Yellow
    Start-Process "http://127.0.0.1:$port"
    exit 0
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Starting ChatGPT OpenAI Local API Bridge" -ForegroundColor Cyan
Write-Host " Listening on port: $port (http://127.0.0.1:$port)" -ForegroundColor Cyan
Write-Host " Management Dashboard: http://127.0.0.1:$port/" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

$serverScript = "file:///" + (Join-Path $PSScriptRoot "server.mjs").Replace("\", "/")
$null | ego-browser nodejs -e "await import('$serverScript')"