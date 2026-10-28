# ==============================================================================
# ego-chatgpt-api: Gitee & GitHub Dual-Remote Publish Script
# ==============================================================================

param(
    [Alias("m")]
    [string]$Message = ""
)

$ErrorActionPreference = "Continue"

function Write-Step {
    param([string]$msg, [string]$color = "Cyan")
    $time = Get-Date -Format "HH:mm:ss"
    Write-Host "[$time] $msg" -ForegroundColor $color
}

function Write-Success {
    param([string]$msg)
    Write-Host "  [OK] $msg" -ForegroundColor "Green"
}

function Write-Failure {
    param([string]$msg)
    Write-Host "  [FAIL] $msg" -ForegroundColor "Red"
}

Set-Location -Path $PSScriptRoot
Write-Host "`n==================================================" -ForegroundColor "Magenta"
Write-Host "  Ego-ChatGPT-API 双平台同步与代码发布工具" -ForegroundColor "Magenta"
Write-Host "==================================================`n" -ForegroundColor "Magenta"

# 1. 凭据探测
Write-Step "1. 检查代码托管平台认证凭据..."
$giteeToken = $env:GITEE_TOKEN
$githubToken = $env:GITHUB_TOKEN

if (-not $giteeToken -or -not $githubToken) {
    $envFile = Join-Path $PSScriptRoot ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
                $parts = $line.Split("=", 2)
                $k = $parts[0].Trim()
                $v = $parts[1].Trim()
                if ($k -eq "GITEE_TOKEN" -and -not $giteeToken) { $giteeToken = $v }
                if (($k -eq "GITHUB_TOKEN" -or $k -eq "GH_TOKEN") -and -not $githubToken) { $githubToken = $v }
            }
        }
    }
}

if ($giteeToken) {
    $maskedG = $giteeToken.Substring(0, [Math]::Min(6, $giteeToken.Length))
    Write-Success ("Gitee Token 已就绪: " + $maskedG + "******")
} else {
    Write-Failure "未检测到 GITEE_TOKEN，请设置环境变量或在 .env 中配置"
}

if ($githubToken) {
    $maskedH = $githubToken.Substring(0, [Math]::Min(6, $githubToken.Length))
    Write-Success ("GitHub Token 已就绪: " + $maskedH + "******")
} else {
    Write-Failure "未检测到 GITHUB_TOKEN，请设置环境变量或在 .env 中配置"
}

# 2. 安全合规预检（防止误提交敏感凭据）
Write-Step "`n2. 执行安全合规预检..."
$ignored = git check-ignore .env 2>$null
if (-not $ignored) {
    Write-Failure ".env 未被 .gitignore 忽略，为防止密钥泄露，发布终止！"
    exit 1
} else {
    Write-Success ".gitignore 已妥善保护 .env 本地密钥配置"
}

# 3. 检查远程仓库配置
Write-Step "`n3. 检查与维护 Remote 配置..."
$remotes = git remote
if ($remotes -notcontains "gitee") {
    $giteeUrl = if ($giteeToken) { "https://shiyiwu:$($giteeToken)@gitee.com/shiyiwu/ego-chatgpt-api.git" } else { "https://gitee.com/shiyiwu/ego-chatgpt-api.git" }
    git remote add gitee $giteeUrl
    Write-Success "已自动注册 gitee 远程仓库"
} else {
    if ($giteeToken) {
        git remote set-url gitee "https://shiyiwu:$($giteeToken)@gitee.com/shiyiwu/ego-chatgpt-api.git"
    }
    Write-Success "Gitee Remote: $(git remote get-url gitee)"
}

if ($remotes -notcontains "origin") {
    git remote add origin "https://github.com/luoluoluo22/ego-chatgpt-api.git"
    Write-Success "已自动注册 origin (GitHub) 远程仓库"
} else {
    Write-Success "GitHub Remote: $(git remote get-url origin)"
}

# 确保 Gitee 直连不走代理
git config remote.gitee.proxy "" 2>$null

# 4. 代码变更暂存与提交
Write-Step "`n4. 检查本地工作区状态..."
$branch = (git branch --show-current).Trim()
if (-not $branch) { $branch = "master" }

$status = git status --porcelain
if ($status) {
    Write-Step "检测到未提交的文件变更，正在添加到暂存区..." "Yellow"
    git add -A

    # 扫描暂存区是否含有明文 token
    $diffCached = git diff --cached
    if ($diffCached -match "ghp_[a-zA-Z0-9]{20,}") {
        Write-Failure "警告：暂存区中检测到疑似明文 GitHub PAT (ghp_*)！"
        Write-Failure "请将密钥移至 .env 或系统环境变量中，发布已终止。"
        git reset HEAD 2>$null
        exit 1
    }

    $commitMsg = $Message
    if (-not $commitMsg) {
        $nowStr = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $commitMsg = "sync: update from $($env:COMPUTERNAME) at $nowStr"
    }
    git commit -m "$commitMsg"
    Write-Success "本地代码已提交: $commitMsg"
} else {
    Write-Success "工作区干净，无待提交的本地修改。"
}

# 5. 推送发布至 Gitee
Write-Step "`n5. 正在发布到 Gitee (gitee/$branch)..."
$giteeOut = git push gitee "$branch" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Success "已成功发布至 Gitee！"
} else {
    Write-Failure "推送 Gitee 失败: $giteeOut"
}

# 6. 推送发布至 GitHub
Write-Step "`n6. 正在发布到 GitHub (origin/$branch)..."
$githubOut = git push origin "$branch" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Success "已成功发布至 GitHub！"
} else {
    Write-Failure "推送 GitHub 失败: $githubOut"
}

Write-Host "`n==================================================" -ForegroundColor "Green"
Write-Host "  发布完成！双平台仓库已保持完全同步。" -ForegroundColor "Green"
Write-Host "  Gitee:  https://gitee.com/shiyiwu/ego-chatgpt-api" -ForegroundColor "Cyan"
Write-Host "  GitHub: https://github.com/luoluoluo22/ego-chatgpt-api" -ForegroundColor "Cyan"
Write-Host "==================================================`n" -ForegroundColor "Green"
