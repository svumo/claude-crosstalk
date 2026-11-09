# Press Send in another account's Claude window (the one started by claude-app.ps1 <profile>),
# using Windows UI Automation. No computer-use tools needed.
#   claude-press-send.ps1 fuuk ["text the prompt box must contain"]
# Finds the claude.exe whose --user-data-dir is ~\.claude-<profile>-app, waits up to 40 s for the
# prompt box to hold the text (if given) and Send to be enabled, then invokes Send.
param(
    [Parameter(Mandatory)][string]$Profile,
    [string]$Expect,
    [string]$Folder,   # if a "Trust this workspace?" dialog shows exactly this folder, press "Trust workspace"
    [int]$TimeoutSec = 40
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$all = [System.Windows.Automation.Condition]::TrueCondition

$main = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath -match 'WindowsApps' }
$proc = if ($Profile -in 'default', 'main') {
    $main | Where-Object { $_.CommandLine -notmatch 'user-data-dir' } | Select-Object -First 1
} else {
    $main | Where-Object { $_.CommandLine -like "*\.claude-$Profile-app*" } | Select-Object -First 1
}
if (-not $proc) { Write-Error "No Claude window running for profile '$Profile' (run claude-app.ps1 $Profile)"; exit 1 }

$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$proc.ProcessId)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $cond)) {
        # The first query switches Chromium's accessibility tree on; later ones see the page.
        $els = $w.FindAll($TS::Descendants, $all)
        $dlg = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Window' -and $_.Current.Name -eq 'Trust this workspace?' } | Select-Object -First 1
        if ($dlg) {
            $shown = $dlg.FindAll($TS::Descendants, $all) | ForEach-Object { $_.Current.Name }
            $trustBtn = $dlg.FindAll($TS::Descendants, $all) | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -eq 'Trust workspace' } | Select-Object -First 1
            if ($Folder -and $trustBtn -and ($shown -contains $Folder)) {
                $trustBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                "Trusted $Folder in the $Profile window."
                Start-Sleep -Milliseconds 1500
            } else {
                Write-Warning "A trust dialog is open in the $Profile window for a folder I wasn't told to trust; leaving it."
            }
            continue
        }
        $prompt = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $_.Current.Name -eq 'Prompt' } | Select-Object -First 1
        $send = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -eq 'Send' -and $_.Current.IsEnabled } | Select-Object -First 1
        if (-not ($prompt -and $send)) { continue }
        if ($Expect) {
            $texts = $prompt.FindAll($TS::Descendants, $all) | ForEach-Object { $_.Current.Name }
            $vp = $null
            if ($prompt.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $texts += $vp.Current.Value }
            $want = $Expect.Substring(0, [Math]::Min(60, $Expect.Length))
            if (-not ($texts | Where-Object { $_ -and $_.Contains($want) })) {
                # The folder's new-session box kept an older draft (a link never overwrites one):
                # put the expected prompt in through UIA's ValuePattern (no key presses), then re-check.
                if ($vp -and -not $vp.Current.IsReadOnly -and -not $replaced) {
                    $vp.SetValue($Expect); $replaced = $true
                    "Replaced an older draft in the $Profile prompt box."
                    Start-Sleep -Milliseconds 800
                }
                continue
            }
        }
        $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        "Sent in the $Profile window (pid $($proc.ProcessId))."
        exit 0
    }
    Start-Sleep -Milliseconds 1500
}
Write-Error "Gave up after $TimeoutSec s: no enabled Send with the expected prompt in the $Profile window."
exit 1
