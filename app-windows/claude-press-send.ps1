# Press Send in an account's Claude window, through Windows UI Automation: no screenshots, mouse
# or key presses.
#   claude-press-send.ps1 work [-Expect "text the prompt box must hold"] [-Folder "C:\code\my-app"]
# Finds the window for that profile (default = the main window), waits up to -TimeoutSec for the
# prompt box to hold -Expect and for Send to be enabled, then presses Send. If a "Trust this
# workspace?" dialog shows exactly -Folder, it presses "Trust workspace"; any other folder is left
# for you. The control names it looks for are the app's English ones.
param(
    [Parameter(Mandatory)][Alias('Profile')][string]$Name,
    [string]$Expect,
    [string]$Folder,
    [int]$TimeoutSec = 40
)
. (Join-Path $PSScriptRoot 'claude-common.ps1')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$all = [System.Windows.Automation.Condition]::TrueCondition

$proc = Get-ClaudeWindowProcess $Name
if (-not $proc) {
    $how = if ($Name -in 'default', 'main') { 'start the Claude app' } else { "run claude-app.ps1 $Name" }
    Write-Error "No Claude window running for profile '$Name' ($how)."; exit 1
}

$replaced = $false
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$proc.ProcessId)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $cond)) {
        # The first query switches Chromium's accessibility tree on; later ones see the page.
        $els = $w.FindAll($TS::Descendants, $all)
        $dlg = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Window' -and $_.Current.Name -eq 'Trust this workspace?' } | Select-Object -First 1
        if ($dlg) {
            $inDlg = $dlg.FindAll($TS::Descendants, $all)
            $shown = $inDlg | ForEach-Object { $_.Current.Name }
            $trustBtn = $inDlg | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -eq 'Trust workspace' } | Select-Object -First 1
            if ($Folder -and $trustBtn -and ($shown -contains $Folder)) {
                $trustBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                "Trusted $Folder in the $Name window."
                Start-Sleep -Milliseconds 1500
            } else {
                Write-Warning "A trust dialog is open in the $Name window for a folder I wasn't told to trust; leaving it."
            }
            continue
        }
        $prompt = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $_.Current.Name -eq 'Prompt' } | Select-Object -First 1
        $send = $els | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -eq 'Send' -and $_.Current.IsEnabled } | Select-Object -First 1
        if (-not ($prompt -and $send)) { continue }
        if ($Expect) {
            $texts = @($prompt.FindAll($TS::Descendants, $all) | ForEach-Object { $_.Current.Name })
            $vp = $null
            if ($prompt.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $texts += $vp.Current.Value }
            $want = $Expect.Substring(0, [Math]::Min(60, $Expect.Length))
            if (-not ($texts | Where-Object { $_ -and $_.Contains($want) })) {
                # The folder's new-session box kept an older draft (a link never overwrites one):
                # put the expected prompt in through UIA's ValuePattern (no key presses), once.
                if ($vp -and -not $vp.Current.IsReadOnly -and -not $replaced) {
                    $vp.SetValue($Expect); $replaced = $true
                    "Replaced an older draft in the $Name prompt box."
                    Start-Sleep -Milliseconds 800
                }
                continue
            }
        }
        $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        "Sent in the $Name window (pid $($proc.ProcessId))."
        exit 0
    }
    Start-Sleep -Milliseconds 1500
}
Write-Error "Gave up after $TimeoutSec s: no enabled Send with the expected prompt in the $Name window."
exit 1
