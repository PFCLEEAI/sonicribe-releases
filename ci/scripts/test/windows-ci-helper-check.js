#!/usr/bin/env node
'use strict';
// Run explicitly with plain Node on a Windows desktop runner; never in the Mac suite.
// Clipboard preservation belongs to the real native helper, so Electron is unnecessary.
const { spawn, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { createWindowsDesktop } = require('../../lib/windows-desktop');
const { childProcessEnvironment } = require('../../lib/child-process-environment');

const DIAGNOSTIC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SonicribeHelperCheck {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, StringBuilder text, uint flags, uint ms, out UIntPtr result);
  public static string ReadEdit(IntPtr window) {
    IntPtr edit=FindWindowEx(window,IntPtr.Zero,"Edit",null);
    if(edit==IntPtr.Zero) throw new Exception("NOTEPAD_EDIT_MISSING");
    var text=new StringBuilder(65536); UIntPtr result;
    if(SendMessageTimeout(edit,0x000D,(UIntPtr)text.Capacity,text,2,1000,out result)==IntPtr.Zero) throw new Exception("NOTEPAD_READ_TIMEOUT");
    return text.ToString();
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$process = Get-Process -Id ([int]$request.pid)
if ($request.action -eq 'prepare') {
  for ($i=0; $i -lt 100; $i++) {
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 50
  }
  $handle = $process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw 'NOTEPAD_WINDOW_MISSING' }
  [void][SonicribeHelperCheck]::ShowWindowAsync($handle, 9)
  [void][SonicribeHelperCheck]::SetForegroundWindow($handle)
  for ($i=0; $i -lt 20 -and [SonicribeHelperCheck]::GetForegroundWindow() -ne $handle; $i++) { Start-Sleep -Milliseconds 25 }
  if ([SonicribeHelperCheck]::GetForegroundWindow() -ne $handle) { throw 'NOTEPAD_FOCUS_DENIED' }
  [System.Windows.Forms.Clipboard]::SetText([string]$request.original)
  @{ handle = $handle.ToInt64().ToString(); ownerId = $process.Id.ToString() } | ConvertTo-Json -Compress
} elseif ($request.action -eq 'inspect') {
  @{ text = [SonicribeHelperCheck]::ReadEdit([IntPtr]([long]$request.handle)); clipboard = [System.Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress
} else { throw 'INVALID_CHECK_OPERATION' }
`;

async function runCheck() {
  const report = { foregroundMs: [], pasteMs: null, pastedOk: false, clipboardRestored: false, errors: [] };
  if (process.platform !== 'win32') { report.errors.push('WINDOWS_ONLY'); return report; }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = childProcessEnvironment({}, process.env, 'win32');
  const diagnostic = payload => new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(DIAGNOSTIC_SCRIPT, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) { reject(new Error('WINDOWS_CHECK_DIAGNOSTIC_FAILED')); return; }
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error('WINDOWS_CHECK_DIAGNOSTIC_INVALID_JSON')); }
    });
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify(payload));
  });
  const desktop = createWindowsDesktop();
  let notepad;
  try {
    await desktop.warmup(); // Startup/compile is separate from the three warm requests.
    for (let i = 0; i < 3; i++) {
      const start = performance.now(); await desktop.foreground(); report.foregroundMs.push(performance.now() - start);
    }
    notepad = spawn(path.win32.join(systemRoot, 'System32', 'notepad.exe'), [], { env, windowsHide: false, stdio: 'ignore' });
    await new Promise((resolve, reject) => { notepad.once('spawn', resolve); notepad.once('error', reject); });
    const original = 'ORIGINAL-clipboard-원본', text = '안녕하세요 Sonicribe Windows paste test 123';
    const target = await diagnostic({ action: 'prepare', pid: notepad.pid, original });
    const start = performance.now();
    await desktop.paste(target.handle, target.ownerId, text);
    report.pasteMs = performance.now() - start;
    const inspected = await diagnostic({ action: 'inspect', pid: notepad.pid, handle: target.handle });
    report.pastedOk = inspected.text === text;
    report.clipboardRestored = inspected.clipboard === original;
    if (!report.pastedOk) report.errors.push('NOTEPAD_TEXT_MISMATCH');
    if (!report.clipboardRestored) report.errors.push('CLIPBOARD_NOT_RESTORED');
    if (report.foregroundMs.some(ms => ms > 500)) report.errors.push('FOREGROUND_OVER_500_MS');
  } catch (error) {
    report.errors.push(error.code || error.message || 'WINDOWS_CHECK_FAILED');
  } finally {
    desktop.dispose();
    // Only the scratch Notepad started by this check is terminated, with no save prompt.
    if (notepad?.pid) try { notepad.kill(); } catch (_) { /* Already exited. */ }
  }
  return report;
}
if (require.main === module) runCheck().then(report => {
  console.log(JSON.stringify(report));
  process.exitCode = report.pastedOk && report.clipboardRestored && report.foregroundMs.length === 3 &&
    report.foregroundMs.every(ms => ms <= 500) && report.errors.length === 0 ? 0 : 1;
}, () => { console.log(JSON.stringify({ foregroundMs: [], pasteMs: null, pastedOk: false, clipboardRestored: false, errors: ['WINDOWS_CHECK_FAILED'] })); process.exitCode = 1; });
module.exports = { DIAGNOSTIC_SCRIPT, runCheck };
