# Open a new Claude Code session in an account's Claude window, with the folder chosen and the
# prompt typed in. -Send also presses Send (claude-press-send.ps1, through UI Automation).
#   claude-new-session.ps1 work    "C:\code\my-app" "What to do..." -Send
#   claude-new-session.ps1 default "C:\code\my-app" "What to do..." -Send   (the main window)
# Uses the app's own claude://code/new link (folder = project folder, q = prompt).
# The app turns a leading "/" that came by link into a full-width slash, so "/skill args" is
# rewritten as "Use the skill skill: args" and Claude runs the skill itself.
param(
    [Parameter(Mandatory)][Alias('Profile')][string]$Name,
    [Parameter(Mandatory)][string]$Folder,
    [string]$Prompt,
    [switch]$Send
)

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Write-Error "No such folder: $Folder"; exit 1 }
$Folder = (Resolve-Path -LiteralPath $Folder).Path

if ($Prompt -match '^/([\w:.-]+)\s*(.*)$') {
    $Prompt = if ($Matches[2]) { "Use the $($Matches[1]) skill: $($Matches[2])" } else { "Use the $($Matches[1]) skill." }
}

$url = "claude://code/new?folder=$([Uri]::EscapeDataString($Folder))"
if ($Prompt) { $url += "&q=$([Uri]::EscapeDataString($Prompt))" }

if ($Name -in 'default', 'main') {
    Start-Process $url   # Windows hands every claude:// link to the main window
} else {
    & (Join-Path $PSScriptRoot 'claude-app.ps1') -Name $Name -Link $url
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if ($Send -and $Prompt) {
    & (Join-Path $PSScriptRoot 'claude-press-send.ps1') -Name $Name -Expect $Prompt -Folder $Folder
    exit $LASTEXITCODE
}
