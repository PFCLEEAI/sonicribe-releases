'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { childProcessEnvironment } = require('./child-process-environment');

// No transcript, credential, or user-controlled code is placed in command arguments.
// SendInput is a single attempt: Windows may reject injection into elevated apps (UIPI).
const WINDOWS_DESKTOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using System.Threading;
public static class SonicribeDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] input, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint f, IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr CopyImage(IntPtr h, uint type, int x, int y, uint flags);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CopyEnhMetaFile(IntPtr h, string file);
  [DllImport("gdi32.dll")] public static extern bool DeleteEnhMetaFile(IntPtr h);
  public class Clip { public uint format; public byte[] data; public IntPtr native; public uint kind; }
  static void Open(IntPtr owner) {
    for(int i=0;i<20;i++) { if(OpenClipboard(owner)) return; Thread.Sleep(15); }
    throw new Exception("CLIPBOARD_BUSY");
  }
  static IntPtr Allocate(byte[] bytes) {
    IntPtr memory=GlobalAlloc(2, (UIntPtr)bytes.Length);
    if(memory==IntPtr.Zero) throw new Exception("CLIPBOARD_ALLOCATION_FAILED");
    IntPtr address=GlobalLock(memory);
    if(address==IntPtr.Zero) { GlobalFree(memory); throw new Exception("CLIPBOARD_LOCK_FAILED"); }
    try { Marshal.Copy(bytes,0,address,bytes.Length); } finally { GlobalUnlock(memory); }
    return memory;
  }
  static void Free(Clip entry) {
    if(entry.native==IntPtr.Zero) return;
    if(entry.kind==2) DeleteObject(entry.native);
    else if(entry.kind==14) DeleteEnhMetaFile(entry.native);
    else GlobalFree(entry.native);
    entry.native=IntPtr.Zero;
  }
  public static bool PasteText(IntPtr target, uint targetOwner, string text) {
    // A hidden native owner window lets EmptyClipboard/SetClipboardData work without
    // borrowing the target application's window or leaving a visible console.
    IntPtr owner=CreateWindowEx(0,"STATIC","",0,0,0,0,0,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(owner==IntPtr.Zero) throw new Exception("CLIPBOARD_OWNER_FAILED");
    var saved=new List<Clip>(); uint inserted=0;
    try {
      Open(owner);
      try {
        uint previous=GetClipboardSequenceNumber(), format=0; ulong total=0;
        while((format=EnumClipboardFormats(format))!=0) {
          IntPtr original=GetClipboardData(format);
          if(original==IntPtr.Zero) throw new Exception("CLIPBOARD_SNAPSHOT_FAILED");
          var entry=new Clip(); entry.format=format; saved.Add(entry);
          if(format==2 || format==0x82) { entry.kind=2; entry.native=CopyImage(original,0,0,0,0x2000); }
          else if(format==14 || format==0x8E) { entry.kind=14; entry.native=CopyEnhMetaFile(original,null); }
          else {
            // Palette/metafile-picture/owner-display/GDI-object formats have special
            // ownership rules. Fail before changing them, never discard them.
            if(format==3 || format==9 || format==0x80 || format==0x83 || (format>=0x200 && format<0x400)) throw new Exception("CLIPBOARD_FORMAT_UNSUPPORTED");
            ulong size=GlobalSize(original).ToUInt64(); total+=size;
            if(size==0 || total>64*1024*1024) throw new Exception("CLIPBOARD_SNAPSHOT_LIMIT");
            IntPtr address=GlobalLock(original);
            if(address==IntPtr.Zero) throw new Exception("CLIPBOARD_SNAPSHOT_FAILED");
            try { entry.data=new byte[(int)size]; Marshal.Copy(address,entry.data,0,(int)size); } finally { GlobalUnlock(original); }
          }
          if(entry.data==null && entry.native==IntPtr.Zero) throw new Exception("CLIPBOARD_SNAPSHOT_FAILED");
        }
        IntPtr replacement=Allocate(Encoding.Unicode.GetBytes(text+"\0"));
        try {
          if(GetClipboardSequenceNumber()!=previous) throw new Exception("CLIPBOARD_CHANGED");
          if(!EmptyClipboard() || SetClipboardData(13,replacement)==IntPtr.Zero) throw new Exception("CLIPBOARD_WRITE_FAILED");
          replacement=IntPtr.Zero; inserted=GetClipboardSequenceNumber();
        } finally { if(replacement!=IntPtr.Zero) GlobalFree(replacement); }
      } finally { CloseClipboard(); }
      uint currentOwner=0; GetWindowThreadProcessId(target,out currentOwner);
      if(GetForegroundWindow()!=target || currentOwner!=targetOwner) throw new Exception("PASTE_TARGET_CHANGED");
      bool sent=Paste(); Thread.Sleep(250); return sent;
    } finally {
      try {
        if(inserted!=0) {
          Open(owner);
          try {
            // An intervening user/app copy owns the clipboard. Never overwrite it.
            if(GetClipboardSequenceNumber()==inserted) {
              foreach(var entry in saved) if(entry.data!=null) entry.native=Allocate(entry.data);
              if(!EmptyClipboard()) throw new Exception("CLIPBOARD_RESTORE_FAILED");
              foreach(var entry in saved) {
                if(SetClipboardData(entry.format,entry.native)==IntPtr.Zero) throw new Exception("CLIPBOARD_RESTORE_FAILED");
                entry.native=IntPtr.Zero; // Windows now owns this allocation/handle.
              }
            }
          } finally { CloseClipboard(); }
        }
      } finally { foreach(var entry in saved) Free(entry); DestroyWindow(owner); }
    }
  }
  public static bool Paste() {
    var keys = new ushort[] { 0x11, 0x56, 0x56, 0x11 };
    var events = new INPUT[4];
    for(int i=0;i<4;i++) { events[i].type=1; events[i].data.keyboard.key=keys[i]; events[i].data.keyboard.flags=i>=2?2u:0u; }
    return SendInput(4, events, Marshal.SizeOf(typeof(INPUT))) == 4;
  }
}
'@
# Compile once, then block on stdin while idle. Never echo request text/errors.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $result = $null
if ($request.action -eq 'foreground') {
  $handle = [SonicribeDesktop]::GetForegroundWindow()
  [uint32]$ownerId = 0
  [void][SonicribeDesktop]::GetWindowThreadProcessId($handle, [ref]$ownerId)
  $result = @{ name = $handle.ToInt64().ToString(); bundleId = $ownerId.ToString() }
} elseif ($request.action -eq 'paste') {
  $handle = [IntPtr]([long]$request.handle)
  [uint32]$ownerId = 0
  [void][SonicribeDesktop]::GetWindowThreadProcessId($handle, [ref]$ownerId)
  if (-not [SonicribeDesktop]::IsWindow($handle) -or $ownerId -ne [uint32]$request.ownerId) { throw 'PASTE_TARGET_UNAVAILABLE' }
  if ([SonicribeDesktop]::IsIconic($handle)) { [void][SonicribeDesktop]::ShowWindowAsync($handle, 9) }
  [void][SonicribeDesktop]::SetForegroundWindow($handle)
  for ($i=0; $i -lt 20 -and [SonicribeDesktop]::GetForegroundWindow() -ne $handle; $i++) { Start-Sleep -Milliseconds 25 }
  if ([SonicribeDesktop]::GetForegroundWindow() -ne $handle) { throw 'PASTE_FOCUS_DENIED' }
  if (-not [SonicribeDesktop]::PasteText($handle, [uint32]$request.ownerId, [string]$request.text)) { throw 'PASTE_INPUT_DENIED' }
  $result = @{ success = $true }
} else { throw 'INVALID_DESKTOP_OPERATION' }
    $response = @{ id = $request.id; result = $result }
  } catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^[A-Z][A-Z_]{2,80}$') { $code = 'WINDOWS_DESKTOP_OPERATION_FAILED' }
    $response = @{ id = $request.id; error = $code }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

const FOREGROUND_TIMEOUT_MS = 500;
const PASTE_TIMEOUT_MS = 3000;
const STARTUP_TIMEOUT_MS = 10000;

function createWindowsDesktop({ spawnProcess = spawn, env = process.env,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] || 'C:\\Windows';
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let current = null, nextId = 0, disposed = false;
  const error = code => Object.assign(new Error(code), { code });
  function fail(state, code) {
    if (state.failed) return;
    state.failed = true;
    if (current === state) current = null;
    clearTimer(state.startupTimer);
    state.rejectReady(error(code));
    for (const entry of state.pending.values()) {
      clearTimer(entry.timer); entry.unsubscribe?.(); entry.reject(error(code));
    }
    state.pending.clear();
    try { state.child.kill(); } catch (_) { /* Already exited. */ }
  }
  function ensureStarted() {
    if (disposed) throw error('WINDOWS_DESKTOP_DISPOSED');
    if (current) return current;
    const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_DESKTOP_SCRIPT, 'utf16le').toString('base64')], {
      env: childProcessEnvironment({}, env, 'win32'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const state = { child, pending: new Map(), buffer: '', failed: false };
    state.ready = new Promise((resolve, reject) => { state.resolveReady = resolve; state.rejectReady = reject; });
    current = state;
    state.startupTimer = setTimer(() => fail(state, 'WINDOWS_DESKTOP_STARTUP_TIMEOUT'), STARTUP_TIMEOUT_MS);
    child.on('error', () => fail(state, 'WINDOWS_DESKTOP_PROCESS_ERROR'));
    child.on('exit', () => fail(state, 'WINDOWS_DESKTOP_EXIT'));
    child.on('close', () => fail(state, 'WINDOWS_DESKTOP_EXIT'));
    child.stdin.on('error', () => fail(state, 'WINDOWS_DESKTOP_STDIN_ERROR'));
    // Drain PowerShell diagnostics without retaining or logging private content.
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      if (state.failed) return;
      state.buffer += chunk.toString('utf8');
      if (state.buffer.length > 65536) { fail(state, 'WINDOWS_DESKTOP_INVALID_RESPONSE'); return; }
      let end;
      while ((end = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, end).trim(); state.buffer = state.buffer.slice(end + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); } catch (_) { fail(state, 'WINDOWS_DESKTOP_INVALID_RESPONSE'); return; }
        if (response.ready === true && !state.isReady) {
          state.isReady = true; clearTimer(state.startupTimer); state.resolveReady(); continue;
        }
        const entry = state.pending.get(response.id);
        if (!entry) continue; // A stale/unknown ID never resolves another request.
        state.pending.delete(response.id); clearTimer(entry.timer); entry.unsubscribe?.();
        if (response.error) entry.reject(error(/^[A-Z_]{3,81}$/.test(response.error) ? response.error : 'WINDOWS_DESKTOP_OPERATION_FAILED'));
        else if (!response.result || typeof response.result !== 'object') {
          entry.reject(error('WINDOWS_DESKTOP_INVALID_RESPONSE')); fail(state, 'WINDOWS_DESKTOP_INVALID_RESPONSE');
        } else entry.resolve(response.result);
      }
    });
    return state;
  }
  async function warmup() { const state = ensureStarted(); await state.ready; }
  async function operation(payload, signal) {
    if (signal?.aborted) throw error('WINDOWS_DESKTOP_ABORTED');
    const state = ensureStarted();
    // The request deadline includes cold compilation. Prewarming has a separate
    // startup bound, and recording never awaits it. A paste is never replayed.
    const timer = setTimer(() => fail(state, 'WINDOWS_DESKTOP_REQUEST_TIMEOUT'),
      payload.action === 'foreground' ? FOREGROUND_TIMEOUT_MS : PASTE_TIMEOUT_MS);
    const abort = () => fail(state, 'WINDOWS_DESKTOP_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await state.ready;
      if (state.failed || current !== state) throw error('WINDOWS_DESKTOP_EXIT');
      if (signal?.aborted) { fail(state, 'WINDOWS_DESKTOP_ABORTED'); throw error('WINDOWS_DESKTOP_ABORTED'); }
      return await new Promise((resolve, reject) => {
        const id = ++nextId;
        state.pending.set(id, { resolve, reject, timer, unsubscribe: () => signal?.removeEventListener('abort', abort) });
        try { state.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
        catch (_) { fail(state, 'WINDOWS_DESKTOP_STDIN_ERROR'); }
      });
    } finally {
      clearTimer(timer); signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({
    warmup,
    dispose() { disposed = true; if (current) fail(current, 'WINDOWS_DESKTOP_DISPOSED'); },
    foreground: () => operation({ action: 'foreground' }),
    paste: (handle, ownerId, text, { signal } = {}) => {
      if (!/^[1-9]\d{0,18}$/.test(String(handle)) || !/^[1-9]\d{0,9}$/.test(String(ownerId))) return Promise.reject(new Error('PASTE_TARGET_UNAVAILABLE'));
      if (typeof text !== 'string' || text.length > 2_000_000) return Promise.reject(new Error('PASTE_TEXT_INVALID'));
      return operation({ action: 'paste', handle: String(handle), ownerId: String(ownerId), text }, signal);
    }
  });
}

async function pasteWindowsText({ text, handle, ownerId, desktop, assertCurrent = () => {}, captureAccount }) {
  assertCurrent();
  // The native operation snapshots every raw HGLOBAL format plus bitmap/EMF handles,
  // sends Ctrl+V once, and restores only if its clipboard sequence still matches.
  const account = captureAccount?.(), controller = new AbortController();
  const unsubscribe = account?.onInvalidated(() => controller.abort());
  try {
    account?.assert();
    const result = await desktop.paste(handle, ownerId, text, { signal: controller.signal });
    assertCurrent();
    if (result?.success !== true) throw new Error('PASTE_INPUT_DENIED');
    return result;
  } finally { unsubscribe?.(); }
}

module.exports = { WINDOWS_DESKTOP_SCRIPT, createWindowsDesktop, pasteWindowsText };
