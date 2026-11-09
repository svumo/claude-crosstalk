# Opens an app window on one of its sessions. Windows runs this when a Crosstalk notification is
# clicked: the protocol crosstalk-window:// (registered by install.ps1) hands it the link.
#   claude-open-link.ps1 "crosstalk-window://open?window=fuuk&session=local_1234-abcd"
# Only a plain profile name and an app session id are taken (the shapes the app's own claude://
# links accept); anything else is refused, as any web page or program can start this link.
param([Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

if ($Url.Trim() -notmatch '^crosstalk-window://open\?window=([A-Za-z0-9][A-Za-z0-9_-]{0,30})&session=(local_[A-Za-z0-9-]{1,64})/?$') {
    Write-Error "Not a Crosstalk window link."; exit 1
}
$window = $Matches[1].ToLowerInvariant()
$link = "claude://code/continue?session=$($Matches[2])"

if ($window -in 'default', 'main') {
    Start-Process $link   # Windows hands every claude:// link to the main window
} else {
    & (Join-Path $PSScriptRoot 'claude-app.ps1') -Name $window -Link $link
    exit $LASTEXITCODE
}
