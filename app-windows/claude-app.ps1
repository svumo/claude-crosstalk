# Open a separate Claude desktop window signed into another account.
# Usage: claude-app.ps1 fuuk   (or mikey)
# Each profile gets its own app data folder (~\.claude-<profile>-app), so its sign-in,
# sidebar and sessions stay apart from the main window. Code sessions in it use
# ~\.claude-<profile> as their Claude Code config folder.
# Sign-in: the browser's "Open Claude" link always goes to the main window. Copy that
# claude://... link and pass it as the second argument to hand it to this window instead:
#   claude-app.ps1 fuuk "claude://..."
param([Parameter(Mandatory)][string]$Profile, [string]$Link)

$pkg = Get-AppxPackage -Name Claude | Select-Object -First 1
if (-not $pkg) { Write-Error "Claude desktop app not found"; exit 1 }
$exe = Join-Path $pkg.InstallLocation 'app\claude.exe'

$userData = Join-Path $env:USERPROFILE ".claude-$Profile-app"
$configDir = Join-Path $env:USERPROFILE ".claude-$Profile"
New-Item -ItemType Directory -Force $userData | Out-Null

$env:CLAUDE_CONFIG_DIR = $configDir
if ($Link) {
    $Link = $Link.Trim()
    if ($Link -notmatch '^claude://') { Write-Error "That isn't a claude:// link (got: $(($Link -split '\?')[0])). Copy the 'Open Claude' link address and try again."; exit 1 }
}
$argList = @("--user-data-dir=`"$userData`"")
if ($Link) { $argList += "`"$Link`"" }
# If this profile's window is already open, Electron hands the arguments (and the link) to it.
Start-Process -FilePath $exe -ArgumentList $argList
