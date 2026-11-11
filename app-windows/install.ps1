# Installs the app-windows scripts and the move-chat skill.
#   install.ps1                         copy the scripts, and the skill into every profile
#   install.ps1 -Shortcuts work,studio    also make a Start-menu shortcut "Claude (<name>)" for each
#   install.ps1 -WhatIf                 only say what it would do
#   install.ps1 -Uninstall              remove the notification names Crosstalk registered
# The scripts go to Crosstalk's shared folder (CLAUDE_CROSSTALK_DIR, default ~\.claude-crosstalk)
# under app-windows\, so every profile finds them in one place that doesn't move when Crosstalk
# updates. A profile is ~\.claude or ~\.claude-<name> that holds Claude Code's files.
#
# Notifications that open the right window: for each app window (~\.claude-<name>-app) it builds
# ToastHost.exe with the csc.exe that comes with Windows, gives the window a notification name
# ("Claude (<name>)", on the Start-menu shortcut of that name), and removes nothing else.
[CmdletBinding(SupportsShouldProcess)]
param([string[]]$Shortcuts = @(), [switch]$Uninstall, [switch]$NoLink)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

$dest = Join-Path (Get-CrosstalkDir) 'app-windows'
$scripts = 'claude-common.ps1', 'claude-app.ps1', 'claude-new-session.ps1', 'claude-press-send.ps1', 'claude-open-link.ps1', 'claude-toast.ps1', 'ToastHost.cs'

# What an earlier build registered (a crosstalk-window: link) is not used any more.
$old = 'HKCU:\Software\Classes\crosstalk-window', 'HKCU:\Software\Classes\Crosstalk.WindowLink', 'HKCU:\Software\Crosstalk'
if ($Uninstall) {
    foreach ($k in $old + 'HKCU:\Software\Classes\AppUserModelId\Crosstalk.Claude.*') {
        if (Test-Path $k) { if ($PSCmdlet.ShouldProcess($k, 'Remove')) { Remove-Item -Path $k -Recurse -Force; "Removed $k" } }
    }
    $ra = 'HKCU:\Software\RegisteredApplications'
    if ((Get-ItemProperty $ra -ErrorAction SilentlyContinue).Crosstalk) { Remove-ItemProperty -Path $ra -Name Crosstalk; "Removed RegisteredApplications\Crosstalk" }
    return
}

if ($PSCmdlet.ShouldProcess($dest, 'Copy the app-windows scripts')) {
    New-Item -ItemType Directory -Force $dest | Out-Null
    foreach ($s in $scripts) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $s) -Destination $dest -Force
        if ($s -like '*.ps1') { Unblock-File -LiteralPath (Join-Path $dest $s) }
    }
    "Scripts: $dest"
}

if (-not $NoLink -and $PSCmdlet.ShouldProcess($dest, 'Set up notifications that open the right window')) {
    foreach ($k in $old) { if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force } }
    $ra = 'HKCU:\Software\RegisteredApplications'
    if ((Get-ItemProperty $ra -ErrorAction SilentlyContinue).Crosstalk) { Remove-ItemProperty -Path $ra -Name Crosstalk }

    $built = Build-ToastHost (Join-Path $dest 'ToastHost.cs') (Join-Path $dest 'ToastHost.exe')
    if ($built) { "Built: $(Join-Path $dest 'ToastHost.exe')" } else { Write-Warning "Couldn't build ToastHost.exe (csc.exe not found), so notifications from a profile's window won't open that window." }

    $exe = Find-ClaudeExe
    $menu = [Environment]::GetFolderPath('Programs')
    # The Claude logo, kept here so notifications still show it after the app updates.
    $logo = Update-ClaudeLogo $dest
    if (-not $logo) { Write-Warning "Couldn't copy the Claude logo, so notifications may show no icon." }
    foreach ($d in Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force | Where-Object { $_.Name -match '^\.claude-(.+)-app$' }) {
        $win = ($d.Name -replace '^\.claude-', '' -replace '-app$', '').ToLowerInvariant()
        if ($win -notmatch '^[a-z0-9][a-z0-9_-]{0,30}$') { continue }
        $k = "HKCU:\Software\Classes\AppUserModelId\Crosstalk.Claude.$win"
        New-Item -Path $k -Force | Out-Null
        New-ItemProperty -Path $k -Name DisplayName -Value "Claude ($win)" -Force | Out-Null
        if ($exe) { New-ItemProperty -Path $k -Name IconUri -Value $exe -Force | Out-Null }
        # The Start-menu shortcut "Claude (<win>)" carries that identity.
        $lnk = Join-Path $menu "Claude ($win).lnk"
        if (-not (Test-Path -LiteralPath $lnk)) {
            $shellExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
            if (-not $shellExe) { $shellExe = (Get-Command powershell.exe).Source }
            $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
            $sc.TargetPath = $shellExe
            $sc.Arguments = "-NoProfile -WindowStyle Hidden -File `"$(Join-Path $dest 'claude-app.ps1')`" $win"
            if ($exe) { $sc.IconLocation = "$exe,0" }
            $sc.Save()
            "Shortcut: $lnk"
        }
        Set-ShortcutAppId $lnk "Crosstalk.Claude.$win"
        Set-NotifyLogo $win $logo
        "Notifications: $win"
    }
}

# The same rule as Crosstalk's setup (hooks/setup.mjs): .claude or .claude-<name>, not Crosstalk's
# own folder or an app window's data folder, holding one of Claude Code's own files.
$marks = 'settings.json', 'plugins', 'projects', '.credentials.json', '.claude.json', 'history.jsonl'
$profiles = Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force |
    Where-Object { $_.Name -match '^\.claude(-.+)?$' -and $_.Name -ne '.claude-crosstalk' -and $_.Name -notmatch '-app$' } |
    Where-Object { $dir = $_.FullName; $marks | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) } }

$skill = Join-Path $PSScriptRoot 'skills\move-chat'
foreach ($p in $profiles) {
    $skills = Join-Path $p.FullName 'skills'
    if ($PSCmdlet.ShouldProcess($skills, 'Copy the move-chat skill')) {
        New-Item -ItemType Directory -Force $skills | Out-Null
        Copy-Item -LiteralPath $skill -Destination $skills -Recurse -Force
        "Skill: $(Join-Path $skills 'move-chat')"
    }
}
if (-not $profiles) { Write-Warning "No Claude Code profiles found in $env:USERPROFILE, so the move-chat skill wasn't copied." }

if ($Shortcuts.Count) {
    $shell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if (-not $shell) { $shell = (Get-Command powershell.exe).Source }
    $menu = [Environment]::GetFolderPath('Programs')
    if (-not $menu) { Write-Warning "Couldn't find the Start menu folder, so no shortcuts were made."; $Shortcuts = @() }
    $exe = Find-ClaudeExe
    foreach ($name in $Shortcuts) {
        if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$' -or $name -in 'default', 'main') { Write-Warning "Skipped shortcut '$name': not a profile name."; continue }
        $lnk = Join-Path $menu "Claude ($name).lnk"
        if ($PSCmdlet.ShouldProcess($lnk, 'Make a Start-menu shortcut')) {
            $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
            $sc.TargetPath = $shell
            $sc.Arguments = "-NoProfile -WindowStyle Hidden -File `"$(Join-Path $dest 'claude-app.ps1')`" $name"
            if ($exe) { $sc.IconLocation = "$exe,0" }
            $sc.Save()
            "Shortcut: $lnk"
        }
    }
}
