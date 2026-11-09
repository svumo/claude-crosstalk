# Open a new Claude Code session in an account's Claude window, with the folder chosen and the
# prompt typed in. -Send also presses Send (claude-press-send.ps1, through UI Automation).
#   claude-new-session.ps1 work    "C:\code\my-app" "What to do..." -Send
#   claude-new-session.ps1 default "C:\code\my-app" "What to do..." -Send   (the main window)
#   claude-new-session.ps1 here    "C:\code\my-app" "What to do..." -Send   (the window you're in)
# `here` is the app window the calling session runs in (a Terminal-panel tab counts as its
# window's), or that session's own profile's window when it isn't in the app. A named profile
# always wins. -DryRun says which window it would use and why, and opens nothing.
# Uses the app's own claude://code/new link (folder = project folder, q = prompt).
# The app turns a leading "/" that came by link into a full-width slash, so "/skill args" is
# rewritten as "Use the skill skill: args" and Claude runs the skill itself.
param(
    [Parameter(Mandatory)][Alias('Profile')][string]$Name,
    [Parameter(Mandatory)][string]$Folder,
    [string]$Prompt,
    [switch]$Send,
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot 'claude-common.ps1')

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Write-Error "No such folder: $Folder"; exit 1 }
$Folder = (Resolve-Path -LiteralPath $Folder).Path

$picked = Resolve-WindowName $Name
if (-not $picked) {
    Write-Error "Can't tell which window '$Name' means here: this session isn't in an app window and CLAUDE_CONFIG_DIR isn't a ~\.claude-<profile> folder. Name the profile instead."
    exit 1
}
$Name = $picked.Name
if ($picked.Why) { "Using the $Name window: $($picked.Why)." }

if ($Prompt -match '^/([\w:.-]+)\s*(.*)$') {
    $Prompt = if ($Matches[2]) { "Use the $($Matches[1]) skill: $($Matches[2])" } else { "Use the $($Matches[1]) skill." }
}

$url = "claude://code/new?folder=$([Uri]::EscapeDataString($Folder))"
if ($Prompt) { $url += "&q=$([Uri]::EscapeDataString($Prompt))" }

if ($DryRun) {
    $running = if (Get-ClaudeWindowProcess $Name) { 'running' } else { 'not running, so it would be started' }
    "Dry run: would open a session in the $Name window ($running), folder $Folder$(if ($Send -and $Prompt) { ', and press Send' })."
    "Link: $url"
    exit 0
}

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
