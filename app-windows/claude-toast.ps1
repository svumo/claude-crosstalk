# Shows a Windows notification for a session in an account's Claude window. Clicking it opens that
# window on that session (claude-open-link.ps1, through the crosstalk-window:// protocol), where the
# app's own notification would open the main window's last session. Windows PowerShell 5.1 or 7.
#   claude-toast.ps1 fuuk local_1234-abcd "Fix the login page" "Needs your approval"
# Skipped when that window is the one in front. The notification is "Claude (<name>)", a name
# install.ps1 registers for the window.
param(
    [Parameter(Mandatory)][string]$Window,
    [Parameter(Mandatory)][string]$Session,
    [Parameter(Mandatory)][string]$Title,
    [string]$Body = '',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

if ($Window -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$') { Write-Error "Not a window name."; exit 1 }
if ($Session -notmatch '^local_[A-Za-z0-9-]{1,64}$') { Write-Error "Not an app session id."; exit 1 }
$Window = $Window.ToLowerInvariant()

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

$aumid = "Crosstalk.Claude.$Window"
$key = "HKCU:\Software\Classes\AppUserModelId\$aumid"
if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value "Claude ($Window)" -Force | Out-Null
}

$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$link = "crosstalk-window://open?window=$Window&session=$Session"
$xml = @"
<toast activationType="protocol" launch="$(& $esc $link)">
  <visual><binding template="ToastGeneric">
    <text>$(& $esc $Title)</text>
    <text>$(& $esc $Body)</text>
  </binding></visual>
</toast>
"@
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
