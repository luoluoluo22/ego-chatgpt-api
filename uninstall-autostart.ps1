# uninstall-autostart.ps1
# 取消 Ego ChatGPT API 服务的开机/登录自启动
$ErrorActionPreference = "Continue"

$taskName = "EgoChatGPTApiBridge"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 移除 Ego ChatGPT API 开机登录自启动 " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[OK] 已成功移除 Windows 计划任务: $taskName" -ForegroundColor Green
} else {
    Write-Host "[INFO] 未发现计划任务: $taskName (无需删除)" -ForegroundColor Yellow
}

# 兼容性检查：若存在历史 Startup 目录快捷方式也一并清理
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutFile = Join-Path $startupFolder "EgoChatGPTApiBridge.lnk"
if (Test-Path -LiteralPath $shortcutFile) {
    Remove-Item -LiteralPath $shortcutFile -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已清理 Startup 目录快捷方式: $shortcutFile" -ForegroundColor Green
}

Write-Host "自启动配置已完全清理。" -ForegroundColor Green
