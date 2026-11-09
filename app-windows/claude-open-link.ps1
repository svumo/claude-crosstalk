# Opens an app window on one of its sessions. Windows runs this when a Crosstalk notification is
# clicked: the protocol crosstalk-window:// (registered by install.ps1) hands it the link.
#   claude-open-link.ps1 "crosstalk-window://open?window=fuuk&session=local_1234-abcd"
# Only a plain profile name and an app session id are taken (the shapes the app's own claude://
# links accept); anything else is refused, as any web page or program can start this link.
param([Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-common.ps1')

# One line per click in <Crosstalk folder>\open-link.log, so "nothing happened" can be told from
# "it ran and went somewhere else".
function Write-LinkLog([string]$Text) {
    try {
        $log = Join-Path (Get-CrosstalkDir) 'open-link.log'
        if ((Test-Path $log) -and (Get-Item $log).Length -gt 100KB) { Remove-Item $log -Force }
        Add-Content -LiteralPath $log -Value "$(Get-Date -Format 's') $Text"
    } catch { }
}
Write-LinkLog "got: $Url"

if ($Url.Trim() -notmatch '^crosstalk-window://open/?\?window=([A-Za-z0-9][A-Za-z0-9_-]{0,30})&session=(local_[A-Za-z0-9-]{1,64})/?$') {
    Write-LinkLog "refused"
    Write-Error "Not a Crosstalk window link."; exit 1
}
$window = $Matches[1].ToLowerInvariant()
# Only a window that already exists: claude-app.ps1 would start a new, signed-out one for any name.
if ($window -notin 'default', 'main' -and -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".claude-$window-app") -PathType Container)) {
    Write-LinkLog "no such window: $window"
    Write-Error "There is no Claude window for '$window'."; exit 1
}
$link = "claude://code/continue?session=$($Matches[2])"

if ($window -in 'default', 'main') {
    Write-LinkLog "main window: $link"
    Start-Process $link   # Windows hands every claude:// link to the main window
} else {
    Write-LinkLog "$window window: $link"
    & (Join-Path $PSScriptRoot 'claude-app.ps1') -Name $window -Link $link
    Write-LinkLog "claude-app.ps1 exit $LASTEXITCODE"
    exit $LASTEXITCODE
}
