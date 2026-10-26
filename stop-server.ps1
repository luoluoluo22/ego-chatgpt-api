# 停止 ChatGPT OpenAI 本地 API 桥接服务
$PORT = 8765

Write-Host "正在查找占用端口 $PORT 的服务进程..." -ForegroundColor Cyan

$conns = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue
if ($conns) {
    $pids = $conns.OwningProcess | Select-Object -Unique
    foreach ($p in $pids) {
        try {
            $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "正在终止进程: $($proc.ProcessName) (PID: $p)..." -ForegroundColor Yellow
                Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    Write-Host "服务已成功停止！" -ForegroundColor Green
} else {
    Write-Host "端口 $PORT 当前未被占用，服务未运行或已停止。" -ForegroundColor Gray
}
