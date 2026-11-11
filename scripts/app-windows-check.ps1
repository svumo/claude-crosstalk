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
    & (Join-Path $root 'install.ps1') -NoLink -WhatIf *>&1 | Out-Null
    Check 'install -WhatIf copies nothing' (-not (Test-Path (Join-Path $home2 '.claude-crosstalk\app-windows')))
    & (Join-Path $root 'install.ps1') -NoLink | Out-Null
} finally {
    $env:USERPROFILE = $oldHome; $env:CLAUDE_CROSSTALK_DIR = $oldDir
}
foreach ($s in 'claude-common.ps1', 'claude-app.ps1', 'claude-new-session.ps1', 'claude-press-send.ps1', 'claude-open-link.ps1', 'claude-toast.ps1') {
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

# Which window a script picks: a process told apart as a window, and 'here' versus a named profile.
. (Join-Path $root 'claude-common.ps1')
$store = 'C:\Program Files\WindowsApps\Claude_4.1.0.0_x64__abc\app\Claude.exe'
Check 'the main window is default' ((Get-WindowNameOf $store "`"$store`"") -eq 'default')
Check 'a claude-app.ps1 window goes by its profile' ((Get-WindowNameOf $store "`"$store`" --user-data-dir=`"C:\Users\me\.claude-Fuuk-app`" `"claude://x`"") -eq 'fuuk')
Check 'an app helper process is not a window' ($null -eq (Get-WindowNameOf $store "`"$store`" --type=utility"))
Check 'the Claude Code CLI is not a window' ($null -eq (Get-WindowNameOf 'C:\Users\me\.local\bin\claude.exe' 'claude.exe'))
$oldWin = $env:CLAUDE_CROSSTALK_WINDOW; $oldCfg = $env:CLAUDE_CONFIG_DIR
try {
    $env:CLAUDE_CROSSTALK_WINDOW = 'fuuk'
    Check 'a named profile wins over here' ((Resolve-WindowName 'Mikey').Name -eq 'mikey' -and -not (Resolve-WindowName 'mikey').Why)
    Check 'here is the window this session is in' ((Resolve-WindowName 'here').Name -eq 'fuuk')
    Check 'no name means here' ((Resolve-WindowName '').Name -eq 'fuuk')
    $env:CLAUDE_CROSSTALK_WINDOW = $null
    if (-not (Get-HostWindowName)) {
        # Outside the app (as in CI), here falls back to this session's own profile.
        $env:CLAUDE_CONFIG_DIR = 'C:\Users\me\.claude-work'
        Check 'outside the app, here is this profile''s window' ((Resolve-WindowName 'here').Name -eq 'work')
        $env:CLAUDE_CONFIG_DIR = $null
        Check 'outside the app with no CLAUDE_CONFIG_DIR, here is the main window' ((Resolve-WindowName 'here').Name -eq 'default')
        $env:CLAUDE_CONFIG_DIR = 'D:\odd place'
        Check 'an unknown config folder is not guessed' ($null -eq (Resolve-WindowName 'here'))
    }
} finally {
    $env:CLAUDE_CROSSTALK_WINDOW = $oldWin; $env:CLAUDE_CONFIG_DIR = $oldCfg
}

# The notification link takes only a plain window name and an app session id, and the toast the same.
function Fails([scriptblock]$Run) { try { & $Run 2>&1 | Out-Null; return ($LASTEXITCODE -ne 0) } catch { return $true } }
foreach ($bad in 'crosstalk-window://open?window=..%5Cx&session=local_1', 'crosstalk-window://open?window=fuuk&session=local_1&q=calc', 'claude://code/new?folder=x', 'calc.exe') {
    Check "claude-open-link.ps1 refuses $bad" (Fails { & pwsh -NoProfile -File (Join-Path $root 'claude-open-link.ps1') $bad })
}
Check 'claude-toast.ps1 refuses a bad window name' (Fails { & pwsh -NoProfile -File (Join-Path $root 'claude-toast.ps1') '..\x' local_1 t b -Force })
Check 'claude-toast.ps1 refuses a bad session id' (Fails { & pwsh -NoProfile -File (Join-Path $root 'claude-toast.ps1') fuuk 'x; calc' t b -Force })

if ($failed) { "$failed failed"; exit 1 }
'All passed'
# The refusal checks above leave $LASTEXITCODE at 1, which would otherwise be the script's exit code.
exit 0
