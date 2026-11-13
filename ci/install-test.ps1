#requires -Version 5.1
<#
.SYNOPSIS
Installs and smoke-tests the unsigned Sonicribe Cloud Windows x64 package.
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-test.ps1 -InstallerPath .\sonicribe-cloud-2.5.22-win-x64.exe
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-test.ps1 -Uninstall
.NOTES
Run as the owner in an unlocked interactive Windows desktop, without elevation.
This smoke test does not prove sign-in, microphone, hotkey, paste, or cloud processing.
Logs: %APPDATA%\Sonicribe Cloud\logs\windows-runtime.jsonl (categories only).
Uninstall preserves the owner's app profile; it never removes user data itself.
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Install')][string]$InstallerPath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Uninstall')][switch]$Uninstall,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\sonicribe-cloud'),
    [string]$OutputDir = (Join-Path (Get-Location) ('sonicribe-windows-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))),
    [ValidateRange(5, 120)][int]$WaitSeconds = 12
)
$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::UtcNow
$exe = Join-Path $InstallDir 'sonicribe-cloud.exe'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Sonicribe Cloud.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sonicribe Cloud.lnk'
$protocolKey = 'HKCU:\Software\Classes\sonicribe-cloud'
$expectedCommand = '"' + $exe + '" "%1"'
$runtimeLog = Join-Path $env:APPDATA 'Sonicribe Cloud\logs\windows-runtime.jsonl'
$ownedProcess = $null
$summary = [ordered]@{
    mode = $(if ($Uninstall) { 'uninstall' } else { 'install-smoke-test' })
    startedAt = $started.ToString('o'); passed = $false
    installer = $InstallerPath; installDir = $InstallDir; runtimeLog = $runtimeLog
    checks = [ordered]@{}; metrics = $null; screenshot = $null
    cleanQuit = $null; error = $null
    manualChecksRequired = @('browser sign-in and app callback', 'Shift+Z start/stop and microphone', 'focused app Ctrl+V and clipboard restoration', 'History', 'Settings', 'tray Quit', 'update install')
}
function Get-OwnedAppProcesses {
    @(Get-Process -Name 'sonicribe-cloud' -ErrorAction SilentlyContinue | Where-Object {
        try { [string]::Equals($_.Path, $exe, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
}
function Assert-Check([string]$Name, [bool]$Value) {
    $summary.checks[$Name] = $Value
    if (-not $Value) { throw ('CHECK_FAILED: ' + $Name) }
}
function Invoke-CleanQuit {
    $running = @(Get-OwnedAppProcesses)
    if ($running.Count -eq 0) { return $true }
    # Second-instance handling calls app.quit(), including normal spool/session cleanup.
    $request = Start-Process -FilePath $exe -ArgumentList '--sonicribe-quit' -PassThru
    [void]$request.WaitForExit(10000)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if (@(Get-OwnedAppProcesses).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false # Never force-kill or dismiss an owner's pending-work dialog.
}
try {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    $OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    if ($Uninstall) {
        Assert-Check 'executableBeforeUninstall' (Test-Path -LiteralPath $exe)
        Assert-Check 'cleanQuitBeforeUninstall' (Invoke-CleanQuit)
        $uninstaller = Join-Path $InstallDir 'Uninstall sonicribe-cloud.exe'
        Assert-Check 'uninstallerExists' (Test-Path -LiteralPath $uninstaller)
        $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
        Assert-Check 'uninstallerFinished' ($remove.WaitForExit(120000))
        Assert-Check 'uninstallerExitZero' ($remove.ExitCode -eq 0)
        # NSIS may hand removal to its temporary copy; observe rather than rerun it.
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ((Test-Path -LiteralPath $exe) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Assert-Check 'executableRemoved' (-not (Test-Path -LiteralPath $exe))
        Assert-Check 'startMenuRemoved' (-not (Test-Path -LiteralPath $startMenu))
        Assert-Check 'desktopShortcutRemoved' (-not (Test-Path -LiteralPath $desktop))
        $remainingCommand = if (Test-Path ($protocolKey + '\shell\open\command')) { (Get-Item ($protocolKey + '\shell\open\command')).GetValue('') } else { $null }
        Assert-Check 'ownProtocolRemoved' (-not [string]::Equals($remainingCommand, $expectedCommand, [StringComparison]::OrdinalIgnoreCase))
        $summary.passed = $true
    } else {
        Assert-Check 'noExistingAppProcess' (@(Get-OwnedAppProcesses).Count -eq 0)
        $InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
        $summary.installer = $InstallerPath
        $summary.installerSha256 = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $install = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru
        Assert-Check 'installerFinished' ($install.WaitForExit(120000))
        Assert-Check 'installerExitZero' ($install.ExitCode -eq 0)
        Assert-Check 'installDirectory' (Test-Path -LiteralPath $InstallDir -PathType Container)
        Assert-Check 'mainExecutable' (Test-Path -LiteralPath $exe)
        Assert-Check 'appAsar' (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\app.asar'))
        Assert-Check 'windowsFfmpeg' (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\ffmpeg\ffmpeg.exe'))
        Assert-Check 'startMenuShortcut' (Test-Path -LiteralPath $startMenu)
        Assert-Check 'desktopShortcut' (Test-Path -LiteralPath $desktop)
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startMenu)
        Assert-Check 'shortcutTarget' ([string]::Equals($shortcut.TargetPath, $exe, [StringComparison]::OrdinalIgnoreCase))
        Assert-Check 'hkcuProtocol' (Test-Path -LiteralPath $protocolKey)
        Assert-Check 'urlProtocolMarker' ((Get-Item $protocolKey).GetValueNames() -contains 'URL Protocol')
        $command = (Get-Item ($protocolKey + '\shell\open\command')).GetValue('')
        Assert-Check 'protocolCommand' ([string]::Equals($command, $expectedCommand, [StringComparison]::OrdinalIgnoreCase))
        $ownedProcess = Start-Process -FilePath $exe -PassThru
        Start-Sleep -Seconds $WaitSeconds
        $ownedProcess.Refresh()
        Assert-Check 'mainProcessAlive' (-not $ownedProcess.HasExited)
        $cpuBefore = $ownedProcess.TotalProcessorTime.TotalMilliseconds
        Start-Sleep -Seconds 2
        $ownedProcess.Refresh()
        $cpuAfter = $ownedProcess.TotalProcessorTime.TotalMilliseconds
        $summary.metrics = [ordered]@{
            pid = $ownedProcess.Id; workingSetBytes = $ownedProcess.WorkingSet64
            privateBytes = $ownedProcess.PrivateMemorySize64
            cpuTotalSeconds = $ownedProcess.TotalProcessorTime.TotalSeconds
            cpuPercentOneCore = [Math]::Round(($cpuAfter - $cpuBefore) / 2000 * 100, 2)
        }
        Assert-Check 'runtimeLogExists' (Test-Path -LiteralPath $runtimeLog)
        $events = @(Get-Content -LiteralPath $runtimeLog | ForEach-Object {
            try { $row = $_ | ConvertFrom-Json; if ([DateTimeOffset]::Parse($row.at) -ge $started) { $row } } catch { }
        })
        Assert-Check 'startupLogged' (@($events | Where-Object { $_.event -eq 'startup' -and $_.pid -eq $ownedProcess.Id }).Count -ge 1)
        Assert-Check 'noFatalRuntimeEvents' (@($events | Where-Object { $_.event -like 'fatal-*' }).Count -eq 0)
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SonicribeSmokeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
}
'@
        $ownedProcess.Refresh()
        $handle = $ownedProcess.MainWindowHandle
        Assert-Check 'appWindowAvailable' ($handle -ne [IntPtr]::Zero)
        [void][SonicribeSmokeWindow]::ShowWindowAsync($handle, 9)
        [void][SonicribeSmokeWindow]::SetForegroundWindow($handle)
        Start-Sleep -Milliseconds 800
        $rect = New-Object SonicribeSmokeWindow+RECT
        Assert-Check 'appWindowBounds' ([SonicribeSmokeWindow]::GetWindowRect($handle, [ref]$rect))
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
        Assert-Check 'appWindowVisibleSize' ($width -gt 0 -and $height -gt 0)
        $bitmap = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
            $summary.screenshot = Join-Path $OutputDir 'sonicribe-window.png'
            $bitmap.Save($summary.screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
        Assert-Check 'screenshotSaved' (Test-Path -LiteralPath $summary.screenshot)
        $summary.passed = $true
    }
} catch { $summary.error = $_.Exception.Message; $summary.passed = $false }
finally {
    if ($null -ne $ownedProcess) {
        try { $summary.cleanQuit = Invoke-CleanQuit } catch { $summary.cleanQuit = $false }
        if (-not $summary.cleanQuit) { $summary.passed = $false }
    }
    $summary.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $json = $summary | ConvertTo-Json -Depth 8
    if (Test-Path -LiteralPath $OutputDir) { $json | Out-File -LiteralPath (Join-Path $OutputDir 'summary.json') -Encoding utf8 }
    Write-Output $json
}
if ($summary.passed) { exit 0 } else { exit 1 }
