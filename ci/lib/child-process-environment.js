'use strict';

// Shared by main and optional encoders. Never pass launcher credentials to child tools.
const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMDATA',
  'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'HOMEBREW_NO_AUTO_UPDATE', 'HOMEBREW_NO_INSTALL_FROM_API']);
// Windows names are case-insensitive, but preserve the original casing for tools.
// This is still an allowlist: launcher/provider credentials never reach helpers.
const windowsAllowed = new Set([...allowed, 'PSModulePath', 'SystemDrive', 'ALLUSERSPROFILE',
  'PUBLIC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME',
  'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'CommonProgramFiles',
  'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramW6432'].map(key => key.toLowerCase()));
function childProcessEnvironment(overrides = {}, base = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const entries = new Map();
    for (const [key, value] of [...Object.entries(base), ...Object.entries(overrides)]) {
      const normalized = key.toLowerCase();
      if (windowsAllowed.has(normalized)) entries.set(normalized, [key, value]);
    }
    return Object.fromEntries([...entries.values()].filter(([, value]) => typeof value === 'string'));
  }
  return Object.fromEntries(Object.entries({ ...base, ...overrides })
    .filter(([key, value]) => allowed.has(key) && typeof value === 'string'));
}
module.exports = { childProcessEnvironment };
