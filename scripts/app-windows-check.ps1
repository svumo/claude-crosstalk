# Checks the app-windows scripts without the desktop app: every script parses, and install.ps1
# puts the scripts and the skill where they belong in a throwaway home folder.
#   pwsh -NoProfile -File scripts/app-windows-check.ps1
#   powershell -NoProfile -File scripts/app-windows-check.ps1
# Prints PASS or FAIL lines and exits 1 on any failure.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\app-windows' | Resolve-Path
$failed = 0
function Check([string]$What, [bool]$Ok) {
    if ($Ok) { "PASS $What" } else { "FAIL $What"; $script:failed++ }
}

foreach ($f in Get-ChildItem -LiteralPath $root -Filter *.ps1) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors)
    Check "$($f.Name) parses ($($PSVersionTable.PSVersion))" (-not $errors)
    if ($errors) { $errors | ForEach-Object { "  $($_.Extent.StartLineNumber): $($_.Message)" } }
}

# A home folder with two profiles, an app window's data folder, Crosstalk's own folder and a
# folder that isn't a profile.
$home2 = Join-Path ([IO.Path]::GetTempPath()) "xt-home-$PID"
foreach ($d in '.claude\plugins', '.claude-work', '.claude-work-app\projects', '.claude-crosstalk', '.claude-empty') {
    New-Item -ItemType Directory -Force (Join-Path $home2 $d) | Out-Null
}
Set-Content -LiteralPath (Join-Path $home2 '.claude-work\settings.json') -Value '{}'

$oldHome = $env:USERPROFILE; $oldDir = $env:CLAUDE_CROSSTALK_DIR
try {
    $env:USERPROFILE = $home2; $env:CLAUDE_CROSSTALK_DIR = $null
    & (Join-Path $root 'install.ps1') -WhatIf *>&1 | Out-Null
    Check 'install -WhatIf copies nothing' (-not (Test-Path (Join-Path $home2 '.claude-crosstalk\app-windows')))
    & (Join-Path $root 'install.ps1') | Out-Null
} finally {
    $env:USERPROFILE = $oldHome; $env:CLAUDE_CROSSTALK_DIR = $oldDir
}
foreach ($s in 'claude-common.ps1', 'claude-app.ps1', 'claude-new-session.ps1', 'claude-press-send.ps1') {
    Check "install puts $s in the shared folder" (Test-Path (Join-Path $home2 ".claude-crosstalk\app-windows\$s"))
}
Check 'install puts the skill in .claude' (Test-Path (Join-Path $home2 '.claude\skills\move-chat\SKILL.md'))
Check 'install puts the skill in .claude-work' (Test-Path (Join-Path $home2 '.claude-work\skills\move-chat\SKILL.md'))
Check 'install skips an app data folder' (-not (Test-Path (Join-Path $home2 '.claude-work-app\skills')))
Check 'install skips a folder that is not a profile' (-not (Test-Path (Join-Path $home2 '.claude-empty\skills')))
Check 'install skips Crosstalk''s own folder' (-not (Test-Path (Join-Path $home2 '.claude-crosstalk\skills')))
Remove-Item -Recurse -Force $home2

# claude-app.ps1 must leave the caller's CLAUDE_CONFIG_DIR as it was, even when it stops early.
$env:CLAUDE_CONFIG_DIR = 'C:\keep-me'
try { & (Join-Path $root 'claude-app.ps1') -Name 'bad name!' 2>$null } catch { }
Check 'claude-app.ps1 leaves CLAUDE_CONFIG_DIR alone' ($env:CLAUDE_CONFIG_DIR -eq 'C:\keep-me')
$env:CLAUDE_CONFIG_DIR = $null

if ($failed) { "$failed failed"; exit 1 }
'All passed'
