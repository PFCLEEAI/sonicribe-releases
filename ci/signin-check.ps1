#requires -Version 5.1
<#
.SYNOPSIS
Checks an INSTALLED Sonicribe Cloud in an unlocked Windows CI desktop, without Google.
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-ci-signin-check.ps1
.NOTES
Requires no existing process for this installation. Does not install, sign in, edit
profile data, force-kill processes, or print callback URLs/tokens. A plain second
launch opens the main window even on a fresh profile still showing onboarding.
JSON goes to stdout; exit 0 requires all checks and normal quit to pass.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\sonicribe-cloud'),
    [string]$RuntimeLog = (Join-Path $env:APPDATA 'Sonicribe Cloud\logs\windows-runtime.jsonl')
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $InstallDir 'sonicribe-cloud.exe'
$started = [DateTimeOffset]::UtcNow
$original = $null
$quitRequested = $false
$stage = 'preflight'
$summary = [ordered]@{
    passed = $false; startedAt = $started.ToString('o'); installDir = $InstallDir
    originalPid = $null; checks = [ordered]@{}; variants = @(); error = $null; cleanQuit = $false
}
function Assert-Check([string]$Name, [bool]$Value) {
    $summary.checks[$Name] = $Value
    if (-not $Value) { throw 'CHECK_FAILED' }
}
function Get-AppProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'sonicribe-cloud.exe'" | Where-Object {
        [string]::Equals($_.ExecutablePath, $exe, [StringComparison]::OrdinalIgnoreCase)
    })
}
function Get-MainProcesses {
    @(Get-AppProcesses | Where-Object { $_.CommandLine -notmatch '(?i)(?:^|\s)--type(?:=|\s)' })
}
function Read-OriginalEvents {
    if ($null -eq $original -or -not (Test-Path -LiteralPath $RuntimeLog)) { return @() }
    @(Get-Content -LiteralPath $RuntimeLog -Tail 1000 | ForEach-Object {
        try {
            $row = $_ | ConvertFrom-Json
            if ($row.pid -eq $original.Id -and [DateTimeOffset]::Parse($row.at) -ge $started) { $row }
        } catch { } # A partially appended JSONL row will be read on the next poll.
    })
}
function Event-Count([string]$Category) {
    return @(Read-OriginalEvents | Where-Object { $_.event -eq $Category }).Count
}
function Wait-Condition([scriptblock]$Condition, [int]$Seconds = 10) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}
function Original-Alive {
    $original.Refresh()
    return -not $original.HasExited
}
function One-Original-Main {
    $mains = @(Get-MainProcesses)
    return ($mains.Count -eq 1 -and $mains[0].ProcessId -eq $original.Id)
}
function Close-MainToTray([string]$Label) {
    $handle = [SonicribeSignInWindow]::FindMain([uint32]$original.Id)
    Assert-Check ($Label + ':mainWindow') ($handle -ne [IntPtr]::Zero)
    $beforeHidden = Event-Count 'window-hidden-to-tray'
    Assert-Check ($Label + ':wmCloseSent') ([SonicribeSignInWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero))
    Assert-Check ($Label + ':hiddenAndAlive') (Wait-Condition {
        (Original-Alive) -and (Event-Count 'window-hidden-to-tray') -gt $beforeHidden -and
        -not [SonicribeSignInWindow]::IsWindowVisible($handle)
    })
}
function Request-CleanQuit {
    $script:quitRequested = $true
    $request = Start-Process -FilePath $exe -ArgumentList '--sonicribe-quit' -PassThru
    if (-not $request.WaitForExit(10000)) { return $false }
    return (Wait-Condition { @(Get-AppProcesses).Count -eq 0 } 20)
}
try {
    Assert-Check 'installedExecutable' (Test-Path -LiteralPath $exe -PathType Leaf)
    $exe = (Resolve-Path -LiteralPath $exe).Path
    Assert-Check 'noExistingAppProcesses' (@(Get-AppProcesses).Count -eq 0)
    $commandKey = 'HKCU:\Software\Classes\sonicribe-cloud\shell\open\command'
    Assert-Check 'installedProtocolKey' (Test-Path -LiteralPath $commandKey)
    $expectedCommand = '"' + $exe + '" "%1"'
    Assert-Check 'installedProtocolCommand' ([string]::Equals((Get-Item $commandKey).GetValue(''), $expectedCommand, [StringComparison]::OrdinalIgnoreCase))
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SonicribeSignInWindow {
    private delegate bool EnumProc(IntPtr h, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static IntPtr FindVisible(uint owner) { return Find(owner, false); }
    public static IntPtr FindMain(uint owner) { return Find(owner, true); }
    private static IntPtr Find(uint owner, bool mainOnly) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr ignored) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != owner || !IsWindowVisible(h)) return true;
            StringBuilder text = new StringBuilder(256); GetWindowText(h, text, text.Capacity);
            RECT rect;
            if (text.ToString() != "Sonicribe" || !GetWindowRect(h, out rect)) return true;
            // The 1000x700 main window is distinct from 640x540 onboarding.
            if (mainOnly && (rect.Right-rect.Left < 900 || rect.Bottom-rect.Top < 600)) return true;
            found = h; return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@
    $stage = 'launch'
    $original = Start-Process -FilePath $exe -PassThru
    $summary.originalPid = $original.Id
    Assert-Check 'initialWindow' (Wait-Condition {
        (Original-Alive) -and [SonicribeSignInWindow]::FindVisible([uint32]$original.Id) -ne [IntPtr]::Zero
    } 20)
    # Also exercises plain second-launch restore without changing onboarding settings.
    $second = Start-Process -FilePath $exe -PassThru
    Assert-Check 'secondLaunchExited' ($second.WaitForExit(10000))
    Assert-Check 'mainWindowReady' (Wait-Condition {
        (One-Original-Main) -and [SonicribeSignInWindow]::FindMain([uint32]$original.Id) -ne [IntPtr]::Zero
    })
    Assert-Check 'runtimeProtocolCommand' ([string]::Equals((Get-Item $commandKey).GetValue(''), $expectedCommand, [StringComparison]::OrdinalIgnoreCase))
    foreach ($variant in @('canonical', 'trailing-slash')) {
        $stage = $variant + ':close'
        Close-MainToTray $variant
        $receivedBefore = Event-Count 'auth-callback-received'
        $rejectedBefore = Event-Count 'auth-callback-rejected:no-pending'
        $route = if ($variant -eq 'canonical') { 'sonicribe-cloud://auth/callback' } else { 'sonicribe-cloud://auth/callback/' }
        $callback = $route + '?grant=' + ('A' * 43) + '&state=' + ('B' * 43)
        $stage = $variant + ':callback'
        Start-Process $callback
        Assert-Check ($variant + ':callbackWithin10s') (Wait-Condition {
            (Original-Alive) -and (Event-Count 'auth-callback-received') -gt $receivedBefore -and
            (Event-Count 'auth-callback-rejected:no-pending') -gt $rejectedBefore -and
            (One-Original-Main) -and [SonicribeSignInWindow]::FindMain([uint32]$original.Id) -ne [IntPtr]::Zero
        })
        $summary.variants += [ordered]@{
            variant = $variant; receivedByOriginalPid = $original.Id; rejectionCode = 'no-pending'
            mainProcessIds = @((Get-MainProcesses).ProcessId); mainWindowRestored = $true
        }
    }
    Assert-Check 'noAuthBegin' ((Event-Count 'auth-begin') -eq 0)
    Assert-Check 'noFatalEvents' (@(Read-OriginalEvents | Where-Object { $_.event -like 'fatal-*' }).Count -eq 0)
    $stage = 'quit'
    $summary.cleanQuit = Request-CleanQuit
    Assert-Check 'allAppProcessesGone' $summary.cleanQuit
    $summary.passed = $true
} catch {
    # Exception text from Windows shell/COM may include the URL. Emit a fixed stage only.
    $summary.error = $stage + ':failed'
    $summary.passed = $false
} finally {
    if ($null -ne $original -and -not $quitRequested) {
        try {
            if (Original-Alive) { $summary.cleanQuit = Request-CleanQuit }
            else { $summary.cleanQuit = @(Get-AppProcesses).Count -eq 0 }
        } catch { $summary.cleanQuit = $false }
    }
    if (-not $summary.cleanQuit) { $summary.passed = $false }
    $summary.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Output ($summary | ConvertTo-Json -Depth 8)
}
if ($summary.passed) { exit 0 } else { exit 1 }
