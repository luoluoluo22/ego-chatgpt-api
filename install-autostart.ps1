# install-autostart.ps1
# 将 Ego ChatGPT API 服务注册为 Windows 开机/登录自启动任务 (计划任务)
$ErrorActionPreference = "Stop"

$taskName = "EgoChatGPTApiBridge"
$repoRoot = $PSScriptRoot
$startScript = Join-Path $repoRoot "start-server.ps1"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 配置 Ego ChatGPT API 开机登录自启动 " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $startScript)) {
    Write-Error "找不到启动脚本: $startScript"
    exit 1
}

# 1. 创建计划任务操作 (后台无窗口静默执行)
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
    -WorkingDirectory $repoRoot

# 2. 创建触发器 (用户登录时触发，延时 10 秒等待网络与浏览器底座就绪)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT10S"

# 3. 任务设置 (允许电池供电运行、执行时长无限制、失败自动重试)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# 4. 运行主体 (当前登录用户交互式上下文，保障可访问 ego 浏览器会话与 Cookie)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest

# 5. 注册任务
try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "Ego ChatGPT OpenAI 兼容 API 本地桥接常驻服务 (自动登录自启)" `
        -Force | Out-Null
    
    Write-Host "[OK] 计划任务 '$taskName' 注册成功！" -ForegroundColor Green
    Write-Host "触发时机: 用户 ($currentUser) 登录后延时 10 秒自动拉起" -ForegroundColor Green
    Write-Host "运行方式: 后台静默运行 (无黑框弹窗)" -ForegroundColor Green
    Write-Host "如需移除自启，请运行: .\uninstall-autostart.ps1 或 npm run autostart:disable" -ForegroundColor Cyan
} catch {
    Write-Host "[ERROR] 计划任务注册失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
