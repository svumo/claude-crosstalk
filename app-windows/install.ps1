# Installs the app-windows scripts and the move-chat skill.
#   install.ps1                         copy the scripts, and the skill into every profile
#   install.ps1 -Shortcuts work,fuuk    also make a Start-menu shortcut "Claude (<name>)" for each
#   install.ps1 -WhatIf                 only say what it would do
# The scripts go to Crosstalk's shared folder (CLAUDE_CROSSTALK_DIR, default ~\.claude-crosstalk)
# under app-windows\, so every profile finds them in one place that doesn't move when Crosstalk
# updates. A profile is ~\.claude or ~\.claude-<name> that holds Claude Code's files.
[CmdletBinding(SupportsShouldProcess)]
param([string[]]$Shortcuts = @())
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

$dest = Join-Path (Get-CrosstalkDir) 'app-windows'
$scripts = 'claude-common.ps1', 'claude-app.ps1', 'claude-new-session.ps1', 'claude-press-send.ps1'

if ($PSCmdlet.ShouldProcess($dest, 'Copy the app-windows scripts')) {
    New-Item -ItemType Directory -Force $dest | Out-Null
    foreach ($s in $scripts) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $s) -Destination $dest -Force
        Unblock-File -LiteralPath (Join-Path $dest $s)
    }
    "Scripts: $dest"
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
