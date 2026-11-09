# Shared by the app-windows scripts. Dot-source it: . (Join-Path $PSScriptRoot 'claude-common.ps1')

# The Claude desktop app's own claude.exe: the Microsoft Store (MSIX) copy, else the standard
# installer's copy in %LOCALAPPDATA%\AnthropicClaude. $null when neither is installed.
function Find-ClaudeExe {
    try {
        $pkg = Get-AppxPackage -Name Claude -ErrorAction Stop | Select-Object -First 1
        if ($pkg) {
            $exe = Join-Path $pkg.InstallLocation 'app\claude.exe'
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
    } catch { }
    $installed = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'
    if (Test-Path -LiteralPath $installed) { return $installed }
    return $null
}

# True for the desktop app's own process path. Claude Code's CLI (~\.local\bin) and the copies the
# app runs for its sessions (<data folder>\claude-code\...) are also called claude.exe; they aren't it.
function Test-DesktopAppPath([string]$Path) {
    return $Path -match '\\WindowsApps\\Claude_[^\\]+\\app\\claude\.exe$' -or $Path -match '\\AnthropicClaude\\(app-[^\\]+\\)?claude\.exe$'
}

# The main process of the app window for a profile. 'default' (or 'main') is the window started
# without --user-data-dir; any other name is the one started by claude-app.ps1 <name>.
function Get-ClaudeWindowProcess([string]$Name) {
    $main = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
        Where-Object { $_.CommandLine -notmatch '--type=' -and (Test-DesktopAppPath $_.ExecutablePath) }
    if ($Name -in 'default', 'main') {
        return $main | Where-Object { $_.CommandLine -notmatch 'user-data-dir' } | Select-Object -First 1
    }
    return $main | Where-Object { $_.CommandLine -like "*\.claude-$Name-app*" } | Select-Object -First 1
}

# Where the scripts and handoffs live: Crosstalk's shared folder (CLAUDE_CROSSTALK_DIR, default
# ~\.claude-crosstalk), so every profile finds them.
function Get-CrosstalkDir {
    if ($env:CLAUDE_CROSSTALK_DIR) { return $env:CLAUDE_CROSSTALK_DIR }
    return Join-Path $env:USERPROFILE '.claude-crosstalk'
}
