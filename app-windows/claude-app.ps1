# Open (or bring up) a separate Claude desktop window for another account.
#   claude-app.ps1 work
# The window gets its own data folder, ~\.claude-<name>-app, so its sign-in, sidebar and sessions
# stay apart from the main window. Its Code sessions use ~\.claude-<name> as their Claude Code
# folder, so they get that profile's plugins, settings and Crosstalk.
# Sign in with the emailed code, typed into this window: a browser's "Open Claude" link always
# goes to the main window.
param(
    [Parameter(Mandatory)][Alias('Profile')][string]$Name,
    # A claude:// link to hand to this window, such as claude://code/new?... (claude-new-session.ps1 uses it)
    [string]$Link
)
. (Join-Path $PSScriptRoot 'claude-common.ps1')

if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$' -or $Name -in 'default', 'main') {
    Write-Error "Give a profile name such as work or fuuk (the main window is the app as you normally start it)."; exit 1
}
$exe = Find-ClaudeExe
if (-not $exe) { Write-Error "Claude desktop app not found (looked for the Microsoft Store copy and %LOCALAPPDATA%\AnthropicClaude)."; exit 1 }

if ($Link) {
    $Link = $Link.Trim()
    if ($Link -notmatch '^claude://') { Write-Error "That isn't a claude:// link (got: $(($Link -split '\?')[0]))."; exit 1 }
}

$userData = Join-Path $env:USERPROFILE ".claude-$Name-app"
New-Item -ItemType Directory -Force $userData | Out-Null
$argList = @("--user-data-dir=`"$userData`"")
if ($Link) { $argList += "`"$Link`"" }

# The app passes CLAUDE_CONFIG_DIR on to its Code sessions. Set it only for the app being started,
# so the shell this ran from keeps its own.
$before = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Process')
try {
    $env:CLAUDE_CONFIG_DIR = Join-Path $env:USERPROFILE ".claude-$Name"
    # If this profile's window is already open, the app hands it the arguments (and the link).
    Start-Process -FilePath $exe -ArgumentList $argList
} finally {
    [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $before, 'Process')
}
exit 0
