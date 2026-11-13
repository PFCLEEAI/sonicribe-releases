'use strict';

// Shared by main and optional encoders. Never pass launcher credentials to child tools.
const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMDATA',
  'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'HOMEBREW_NO_AUTO_UPDATE', 'HOMEBREW_NO_INSTALL_FROM_API']);
function childProcessEnvironment(overrides = {}, base = process.env) {
  return Object.fromEntries(Object.entries({ ...base, ...overrides })
    .filter(([key, value]) => allowed.has(key) && typeof value === 'string'));
}
module.exports = { childProcessEnvironment };
