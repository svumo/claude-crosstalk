# Shows a Windows notification for a session in an account's Claude window. Clicking it opens that
# window on that session (claude-open-link.ps1), where the app's own notification would open the
# main window's last session. Windows PowerShell 5.1 or 7.
#   claude-toast.ps1 fuuk local_1234-abcd "Fix the login page" "Needs your approval"
# Skipped when that window is the one in front. The notification is "Claude (<name>)", a name
# install.ps1 gives the window.
#
# Windows takes a notification back when the program that raised it ends, and a click only reaches
# that program while it runs. So ToastHost.exe (built by install.ps1) raises it and stays hidden for
# -WaitMinutes, listening for the click. This script returns at once.
param(
    [Parameter(Mandatory)][string]$Window,
    [Parameter(Mandatory)][string]$Session,
    [Parameter(Mandatory)][string]$Title,
    [string]$Body = '',
    [switch]$Force,
    [int]$WaitMinutes = 15
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

if ($Window -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$') { Write-Error "Not a window name."; exit 1 }
if ($Session -notmatch '^local_[A-Za-z0-9-]{1,64}$') { Write-Error "Not an app session id."; exit 1 }
$Window = $Window.ToLowerInvariant()

$exe = Join-Path $PSScriptRoot 'ToastHost.exe'
if (-not (Test-Path -LiteralPath $exe)) { Write-Error "ToastHost.exe isn't built here: run install.ps1 (or /crosstalk setup yes)."; exit 1 }

if (-not $Force) {
    Add-Type -Namespace Win32 -Name Fg -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
    $fgPid = [uint32]0
    [void][Win32.Fg]::GetWindowThreadProcessId([Win32.Fg]::GetForegroundWindow(), [ref]$fgPid)
    $proc = Get-ClaudeWindowProcess $Window
    if ($proc -and $proc.ProcessId -eq $fgPid) { exit 0 }
    # Chromium puts its windows in child processes of the main one.
    if ($proc -and (Get-CimInstance Win32_Process -Filter "ProcessId=$fgPid" -ErrorAction SilentlyContinue).ParentProcessId -eq $proc.ProcessId) { exit 0 }
}

# The Claude logo on the notification: re-copied when the app has updated, as each update moves it
# to a new folder and leaves the old icon path empty.
$logo = $null
try { $logo = Update-ClaudeLogo $PSScriptRoot; Set-NotifyLogo $Window $logo } catch { }

# The window to bring forward when it's clicked: its main process, which owns the app's windows.
$windowPid = 0
$target = Get-ClaudeWindowProcess $Window
if ($target) { $windowPid = $target.ProcessId }

# One notification per session at a time: a new one replaces the older host for that session.
Get-CimInstance Win32_Process -Filter "Name='ToastHost.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Session*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$q = { param($s) '"' + ($s -replace '"', "'") + '"' }
$argList = @($Window, $Session, (& $q $Title), (& $q $Body), "$WaitMinutes", (& $q (Join-Path $PSScriptRoot 'claude-open-link.ps1')), "$windowPid", (& $q $(if ($logo) { $logo.Png } else { '' })))
Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden
