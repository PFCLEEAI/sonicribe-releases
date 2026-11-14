#requires -Version 5.1
[CmdletBinding()]
param([string]$FeedDir = 'update-feed', [string]$OutputDir = 'out/update')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDir | Out-Null
$OutputDir = (Resolve-Path $OutputDir).Path
$FeedDir = (Resolve-Path $FeedDir).Path
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\sonicribe-cloud-update-test'
$exe = Join-Path $installDir 'sonicribe-cloud-update-test.exe'
$runtime = Join-Path $env:APPDATA 'Sonicribe Cloud Update Test\logs\windows-update-test.jsonl'
$server = $null; $appProcess = $null
$summary = [ordered]@{ passed = $false; checks = [ordered]@{}; before = $null; after = $null; error = $null }
function Assert-Check([string]$Name, [bool]$Value) {
  $summary.checks[$Name] = $Value
  Write-Output "CHECK $Name=$Value"
  if (-not $Value) { throw "CHECK_FAILED:$Name" }
}
function Read-Events {
  if (-not (Test-Path $runtime)) { return @() }
  @(Get-Content $runtime | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} })
}
function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do { if (& $Condition) { return $true }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}
try {
  Assert-Check 'cleanRunner' (-not (Test-Path $exe))
  $serverScript = Join-Path $PSScriptRoot 'windows-update-server.js'
  $server = Start-Process node -ArgumentList @($serverScript, $FeedDir, '18765') -PassThru -RedirectStandardOutput (Join-Path $OutputDir 'http.log') -RedirectStandardError (Join-Path $OutputDir 'http-error.log')
  Assert-Check 'loopbackFeedReady' (Wait-Until { try { (Invoke-WebRequest 'http://127.0.0.1:18765/latest.yml' -UseBasicParsing).StatusCode -eq 200 } catch { $false } } 20)
  $installer = Join-Path $FeedDir 'sonicribe-cloud-0.0.90-win-x64.exe'
  $install = Start-Process $installer -ArgumentList '/S' -PassThru
  Assert-Check 'install90Finished' ($install.WaitForExit(120000))
  Assert-Check 'install90ExitZero' ($install.ExitCode -eq 0)
  Assert-Check 'installedTestExecutable' (Test-Path $exe)
  $versionScript = Join-Path $PSScriptRoot 'windows-update-version.js'
  $summary.before = (& node $versionScript (Join-Path $installDir 'resources\app.asar') '0.0.90' | ConvertFrom-Json)
  Assert-Check 'installedVersion90' ($LASTEXITCODE -eq 0 -and $summary.before.version -eq '0.0.90')
  Write-Output 'UPDATE_PROOF installed=0.0.90'
  $appProcess = Start-Process $exe -PassThru
  Assert-Check 'autoDownloaded91Within300s' (Wait-Until { @(Read-Events | Where-Object { $_.event -eq 'update-downloaded' -and $_.version -eq '0.0.91' }).Count -gt 0 } 300)
  Assert-Check 'automaticCheck' (@(Read-Events | Where-Object { $_.event -eq 'check' -and $_.manual -eq $false }).Count -gt 0)
  Assert-Check 'downloadProgress' (@(Read-Events | Where-Object { $_.event -eq 'download-progress' }).Count -gt 0)
  Write-Output 'UPDATE_PROOF automatic-download=0.0.91'
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  # Invoke the existing native Restart now button, exercising the normal quitAndInstall path.
  Assert-Check 'restartButtonInvoked' (Wait-Until {
    $buttons = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    foreach ($button in $buttons) {
      if ($button.Current.ProcessId -eq $appProcess.Id -and $button.Current.Name -in @('Restart now', '지금 다시 시작')) {
        $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke(); return $true
      }
    }
    return $false
  } 20)
  Assert-Check 'normalQuitAndInstall' (Wait-Until { @(Read-Events | Where-Object { $_.event -eq 'restart' -and $_.version -eq '0.0.91' }).Count -gt 0 } 10)
  Assert-Check 'version91Installed' (Wait-Until {
    try {
      $script:after = (& node $versionScript (Join-Path $installDir 'resources\app.asar') '0.0.91' 2>$null | ConvertFrom-Json)
      return $LASTEXITCODE -eq 0 -and $script:after.version -eq '0.0.91'
    } catch { return $false }
  } 120)
  $summary.after = $script:after
  Write-Output 'UPDATE_PROOF installed=0.0.91'
  # quitAndInstall normally relaunches itself. A plain second start also proves it can launch.
  Start-Sleep -Seconds 5
  $launched = Start-Process $exe -PassThru
  Assert-Check 'updatedAppLaunches' (Wait-Until { @(Get-Process sonicribe-cloud-update-test -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0 } 30)
  Write-Output 'UPDATE_PROOF launched=0.0.91'
  $registry = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Sonicribe Cloud Update Test 0.0.91' })
  $summary.displayVersion = @($registry.DisplayVersion)
  Assert-Check 'registryVersion91' (@($registry | Where-Object { $_.DisplayVersion -eq '0.0.91' }).Count -gt 0)
  $summary.passed = $true
} catch { $summary.error = $_.Exception.Message; Write-Output $summary.error }
finally {
  if (Test-Path $exe) {
    try { & $exe --sonicribe-quit; Start-Sleep -Seconds 3 } catch {}
  }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
  Copy-Item -Recurse -ErrorAction SilentlyContinue (Join-Path $env:APPDATA 'Sonicribe Cloud Update Test\logs') (Join-Path $OutputDir 'app-logs')
  $summary | ConvertTo-Json -Depth 8 | Tee-Object (Join-Path $OutputDir 'summary.json')
}
if ($summary.passed) { exit 0 } else { exit 1 }
