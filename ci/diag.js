'use strict';
// Diagnose why the Windows desktop helper times out: time PowerShell start, C# compile,
// and the real helper with full vs filtered environment (stderr captured, 60 s cap).
const { execFile } = require('node:child_process');
const path = require('node:path');
const { WINDOWS_DESKTOP_SCRIPT } = require('./windows-desktop');
const { childProcessEnvironment } = require('./child-process-environment');
const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');
function run(label, args, { env = process.env, input = null } = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = execFile(exe, args, { env, windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ label, ms: Date.now() - t, code: error ? (error.code ?? error.signal ?? 'ERR') : 0, killed: !!(error && error.killed), stdout: String(stdout).slice(0, 400), stderr: String(stderr).slice(0, 1200) });
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}
(async () => {
  const filtered = childProcessEnvironment({}, process.env);
  const out = { envKeysKept: Object.keys(filtered), envHasPathCase: Object.keys(process.env).filter((k) => /^path$/i.test(k)) };
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  out.r = [];
  out.r.push(await run('ps-hello', [...base, '-Command', '1']));
  out.r.push(await run('ps-hello-filtered-env', [...base, '-Command', '1'], { env: filtered }));
  const csharpOnly = WINDOWS_DESKTOP_SCRIPT.split("$request =")[0] + "\n'compiled'";
  out.r.push(await run('compile-full-env', [...base, '-EncodedCommand', enc(csharpOnly)]));
  out.r.push(await run('compile-filtered-env', [...base, '-EncodedCommand', enc(csharpOnly)], { env: filtered }));
  const req = JSON.stringify({ action: 'foreground' });
  out.r.push(await run('helper-full-env', [...base, '-EncodedCommand', enc(WINDOWS_DESKTOP_SCRIPT)], { input: req }));
  out.r.push(await run('helper-filtered-env', [...base, '-EncodedCommand', enc(WINDOWS_DESKTOP_SCRIPT)], { env: filtered, input: req }));
  out.r.push(await run('helper-filtered-env-again', [...base, '-EncodedCommand', enc(WINDOWS_DESKTOP_SCRIPT)], { env: filtered, input: req }));
  out.r.push(await run('stdin-only-filtered', [...base, '-EncodedCommand', enc("$x = [Console]::In.ReadToEnd(); 'got:' + $x.Length")], { env: filtered, input: req }));
  console.log(JSON.stringify(out, null, 1));
})();
