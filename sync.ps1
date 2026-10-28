param(
    [switch]$Now,
    [switch]$Daemon,
    [int]$IntervalMinutes = 30,
    [string]$Message = ""
)

$ErrorActionPreference = "Continue"

function Write-ColorLog {
    param(
        [string]$msg,
        [string]$color = "Cyan"
    )
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] $msg" -ForegroundColor $color
}

function Invoke-GitSync {
    param(
        [string]$customMsg = ""
    )

    $repoRoot = $PSScriptRoot
    Set-Location -Path $repoRoot

    $branch = (git branch --show-current).Trim()
    if (-not $branch) { $branch = "master" }

    Write-ColorLog "=== Start Git Sync (Branch: $branch) ===" "Cyan"

    $status = git status --porcelain
    if ($status) {
        Write-ColorLog "Local changes detected, committing..." "Yellow"
        git add -A
        $nowStr = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $hostName = $env:COMPUTERNAME
        $commitMsg = if ($customMsg) { $customMsg } else { "sync: update from $hostName at $nowStr" }
        git commit -m "$commitMsg"
        Write-ColorLog "Local changes committed: $commitMsg" "Green"
    } else {
        Write-ColorLog "Working tree clean, no local changes to commit." "DarkGray"
    }

    Write-ColorLog "Fetching and pulling remote updates (git pull --rebase origin $branch)..." "Cyan"
    $pullOut = git pull --rebase origin $branch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ColorLog "[WARN] Git rebase conflict occurred. Aborting rebase to keep local tree safe..." "Red"
        git rebase --abort 2>&1 | Out-Null
        Write-ColorLog "Notice: Conflicts detected with remote. Please resolve manually." "Red"
        return $false
    } else {
        Write-ColorLog "Remote sync result: Success ($($pullOut[0]))" "Green"
    }

    $unpushed = git log "origin/$branch..$branch" --oneline 2>$null
    if ($unpushed) {
        Write-ColorLog "Unpushed commits found, pushing to GitHub (git push origin $branch)..." "Cyan"
        $pushOut = git push origin $branch 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-ColorLog "[ERROR] Push to GitHub failed: $pushOut" "Red"
            return $false
        } else {
            Write-ColorLog "Successfully pushed latest code to GitHub!" "Green"
        }
    } else {
        Write-ColorLog "Local branch is up to date with GitHub, no push needed." "DarkGray"
    }

    # 同步推送至 Gitee
    $unpushedGitee = git log "gitee/$branch..$branch" --oneline 2>$null
    if ($unpushedGitee) {
        Write-ColorLog "Unpushed commits found for Gitee, pushing (git push gitee $branch)..." "Cyan"
        $pushGiteeOut = git push gitee $branch 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-ColorLog "[WARN] Push to Gitee had issue: $pushGiteeOut" "Yellow"
        } else {
            Write-ColorLog "Successfully pushed latest code to Gitee!" "Green"
        }
    } else {
        Write-ColorLog "Local branch is up to date with Gitee, no push needed." "DarkGray"
    }

    Write-ColorLog "=== Sync Complete ===`n" "Green"
    return $true
}

if ($Daemon) {
    Write-ColorLog "[DAEMON MODE STARTED] Sync interval: every $IntervalMinutes minutes." "Magenta"
    Write-ColorLog "Tip: You can run sync-now.bat or .\sync.ps1 -Now anytime for immediate sync." "DarkCyan"
    Write-ColorLog "Press Ctrl+C to stop daemon timer.`n" "DarkGray"

    Invoke-GitSync -customMsg "sync: daemon startup sync"

    while ($true) {
        $intervalSec = $IntervalMinutes * 60
        $nextTime = (Get-Date).AddMinutes($IntervalMinutes).ToString("HH:mm:ss")
        Write-ColorLog "Waiting for next sync (scheduled at $nextTime)..." "DarkGray"
        Start-Sleep -Seconds $intervalSec
        Invoke-GitSync
    }
} else {
    $success = Invoke-GitSync -customMsg $Message
    if (-not $success) {
        exit 1
    }
}
