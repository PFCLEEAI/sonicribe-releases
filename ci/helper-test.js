'use strict';
// Measures the Windows desktop helper (foreground capture + paste) and checks Korean paste
// into Notepad plus clipboard restoration. CI evidence only; never part of the app.
const { createWindowsDesktop } = require('./windows-desktop');
const { spawn, execFileSync } = require('node:child_process');
const ps = (cmd, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { input, encoding: 'utf8' }).trim();
const setClip = (t) => ps('$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t', t);
const getClip = () => ps('[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = { foregroundMs: [], errors: [] };
  const d = createWindowsDesktop();
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try { out.lastForeground = await d.foreground(); } catch (e) { out.errors.push('foreground:' + (e.code || e.message)); }
    out.foregroundMs.push(Date.now() - t);
  }
  const np = spawn('notepad.exe', [], { detached: false });
  await sleep(3000);
  try { ps("$p = Get-Process -Id " + np.pid + "; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id)"); } catch (e) { out.errors.push('activate:' + e.message.slice(0, 200)); }
  await sleep(800);
  let target = null;
  try { target = await d.foreground(); out.notepadTarget = target; out.notepadPid = np.pid; } catch (e) { out.errors.push('foreground2:' + (e.code || e.message)); }
  const original = 'ORIGINAL-clipboard-원본';
  const text = '안녕하세요 Sonicribe Windows paste test 123';
  try { setClip(original); } catch (e) { out.errors.push('setclip:' + e.message.slice(0, 200)); }
  if (target) {
    const t = Date.now();
    try { out.pasteResult = await d.paste(target.name, target.bundleId, text); } catch (e) { out.errors.push('paste:' + (e.code || e.message)); }
    out.pasteMs = Date.now() - t;
  }
  await sleep(1000);
  try {
    out.notepadText = ps("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName UIAutomationClient; $p = Get-Process -Id " + np.pid + "; $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle); $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document); $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c); if (-not $e) { $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit); $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c) }; if ($e) { $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } else { 'NO_EDIT_CONTROL' }");
  } catch (e) { out.errors.push('readnotepad:' + e.message.slice(0, 200)); }
  try { out.clipboardAfter = getClip(); } catch (e) { out.errors.push('getclip:' + e.message.slice(0, 200)); }
  out.pastedOk = typeof out.notepadText === 'string' && out.notepadText.includes(text);
  out.clipboardRestored = out.clipboardAfter === original;
  try { np.kill(); } catch (_) {}
  console.log(JSON.stringify(out, null, 1));
})();
