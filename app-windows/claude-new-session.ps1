# Open a new Claude Code session in an account's Claude window, with the folder chosen and
# the prompt typed in; -Send also presses Send (claude-press-send.ps1, UI Automation).
#   claude-new-session.ps1 fuuk    "C:\path\to\project" "What to do..." -Send
#   claude-new-session.ps1 default "C:\path\to\project" "What to do..." -Send   (main window)
# Uses the app's own claude://code/new link (q = prompt, folder = project folder).
# The app turns a leading "/" from a link into a full-width "／", so "/skill args" is
# rewritten to "Use the skill skill: args" and Claude runs the skill itself.
param(
    [Parameter(Mandatory)][string]$Profile,
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

if ($Profile -in 'default', 'main') {
    Start-Process $url   # Windows always hands claude:// links to the main window
} else {
    & (Join-Path $PSScriptRoot 'claude-app.ps1') $Profile $url
}
if ($Send -and $Prompt) { & (Join-Path $PSScriptRoot 'claude-press-send.ps1') -Profile $Profile -Expect $Prompt -Folder $Folder }
