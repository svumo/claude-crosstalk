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

# Which app window a process is: 'default' for the main window, <name> for one claude-app.ps1
# started (--user-data-dir=~\.claude-<name>-app), $null for any other process. Matches the
# plugin's appWindowOf (hooks/core.mjs).
function Get-WindowNameOf([string]$Path, [string]$CommandLine) {
    if (-not (Test-DesktopAppPath $Path) -or $CommandLine -match '\s--type=') { return $null }
    if ($CommandLine -notmatch '--user-data-dir=(?:"([^"]+)"|(\S+))') { return 'default' }
    $dir = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $leaf = Split-Path -Leaf $dir.TrimEnd('\', '/')
    if ($leaf -match '^\.claude-(.+)-app$') { return $Matches[1].ToLower() }
    return $leaf.ToLower()
}

# The app window this script's session runs in: the nearest app window among its parent
# processes. A Terminal-panel tab runs under the window it is a tab of. $null outside the app.
function Get-HostWindowName {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    for ($i = 0; $i -lt 16 -and $p; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
        if ($p) {
            $name = Get-WindowNameOf $p.ExecutablePath $p.CommandLine
            if ($name) { return $name }
        }
    }
    return $null
}

# The window a script should use for -Name. A named profile always wins. 'here' (or 'window', or
# nothing) means the window the person is working in: the app window this session runs in, else,
# outside the app, the window of this session's own profile (CLAUDE_CONFIG_DIR). Returns
# @{ Name; Why }, with Why empty for a named profile, or $null when it can't tell.
function Resolve-WindowName([string]$Name) {
    if ($Name -and $Name -notin 'here', 'same', 'this', 'window') {
        return @{ Name = $Name.ToLower(); Why = '' }
    }
    if ($env:CLAUDE_CROSSTALK_WINDOW) {
        return @{ Name = $env:CLAUDE_CROSSTALK_WINDOW.ToLower(); Why = 'set by CLAUDE_CROSSTALK_WINDOW' }
    }
    $hostName = Get-HostWindowName
    if ($hostName) { return @{ Name = $hostName; Why = 'the app window this session runs in' } }
    $leaf = if ($env:CLAUDE_CONFIG_DIR) { Split-Path -Leaf $env:CLAUDE_CONFIG_DIR.TrimEnd('\', '/') } else { '.claude' }
    $why = "this session's own profile, as it doesn't run in an app window"
    if ($leaf -eq '.claude') { return @{ Name = 'default'; Why = $why } }
    if ($leaf -match '^\.claude-([A-Za-z0-9][A-Za-z0-9_-]{0,30})$') { return @{ Name = $Matches[1].ToLower(); Why = $why } }
    return $null
}

# Where the scripts and handoffs live: Crosstalk's shared folder (CLAUDE_CROSSTALK_DIR, default
# ~\.claude-crosstalk), so every profile finds them.
function Get-CrosstalkDir {
    if ($env:CLAUDE_CROSSTALK_DIR) { return $env:CLAUDE_CROSSTALK_DIR }
    return Join-Path $env:USERPROFILE '.claude-crosstalk'
}

# Builds ToastHost.exe from its source with the C# compiler that comes with Windows (.NET
# Framework's csc.exe). $true when the program is there afterwards.
function Build-ToastHost([string]$Source, [string]$Output) {
    $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $csc = Join-Path $fw 'csc.exe'
    $wm = Join-Path $env:WINDIR 'System32\WinMetadata'
    if (-not (Test-Path -LiteralPath $csc)) { return (Test-Path -LiteralPath $Output) }
    $refs = "$wm\Windows.UI.winmd", "$wm\Windows.Data.winmd", "$wm\Windows.Foundation.winmd",
        "$fw\System.Runtime.WindowsRuntime.dll", "$fw\System.Runtime.dll", "$fw\System.Runtime.InteropServices.WindowsRuntime.dll"
    # A running copy locks the file; the ones waiting on a notification are ended first.
    Get-Process ToastHost -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Output } | Stop-Process -Force -ErrorAction SilentlyContinue
    $out = & $csc /nologo /target:winexe "/out:$Output" ($refs | ForEach-Object { "/r:$_" }) $Source 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warning ($out | Out-String) }
    return (Test-Path -LiteralPath $Output)
}

# Gives a Start-menu shortcut an app identity (System.AppUserModel.ID). A notification keeps showing
# after the process that raised it ends, and a click on it works, only for an identity that has such
# a shortcut; one that only has a registry name is cleared when its process exits.
function Set-ShortcutAppId([string]$Shortcut, [string]$AppId) {
    if (-not ('Xt.AppIdLink' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Xt {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    interface IPersistFile {
        void GetClassID(out Guid g);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
        uint GetCount();
        void GetAt(uint i, out PropertyKey k);
        void GetValue(ref PropertyKey k, out PropVariant v);
        void SetValue(ref PropertyKey k, ref PropVariant v);
        void Commit();
    }
    public static class AppIdLink {
        public static void Set(string path, string appId) {
            object link = new CShellLink();
            ((IPersistFile)link).Load(path, 2);
            var store = (IPropertyStore)link;
            var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
            var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
            store.SetValue(ref key, ref v);
            store.Commit();
            ((IPersistFile)link).Save(path, true);
        }
    }
}
'@
    }
    [Xt.AppIdLink]::Set($Shortcut, $AppId)
}
