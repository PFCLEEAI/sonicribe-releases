'use strict';
// Read package identity from the installed ASAR without npm, Electron or mutable app code.
const fs = require('node:fs');
function readVersion(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const sizeBuffer = Buffer.alloc(8); fs.readSync(fd, sizeBuffer, 0, 8, 0);
    const size = sizeBuffer.readUInt32LE(4);
    if (size <= 8 || size > 32 * 1024 * 1024) throw new Error('ASAR_HEADER_INVALID');
    const header = Buffer.alloc(size); fs.readSync(fd, header, 0, size, 8);
    const length = header.readUInt32LE(4);
    const files = JSON.parse(header.subarray(8, 8 + length).toString()).files;
    const read = name => {
      const row = files[name];
      if (!row || row.unpacked || row.link || !Number.isSafeInteger(row.size) || row.size > 65536) throw new Error('ASAR_ENTRY_INVALID');
      const bytes = Buffer.alloc(row.size);
      if (fs.readSync(fd, bytes, 0, row.size, 8 + size + Number(row.offset)) !== row.size) throw new Error('ASAR_ENTRY_TRUNCATED');
      return JSON.parse(bytes.toString());
    };
    const pkg = read('package.json'), config = read('release-isolation.json');
    if (config.mode !== 'windows-update-test' || config.windowsUpdateTest !== true ||
        config.identity.appId !== 'com.sonicribe.cloud.update-test' ||
        config.windowsUpdateTestFeed !== 'http://127.0.0.1:18765/') throw new Error('TEST_IDENTITY_REQUIRED');
    return { version: pkg.version, packageName: pkg.name, appId: config.identity.appId, feed: config.windowsUpdateTestFeed };
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  const result = readVersion(process.argv[2]);
  if (result.version !== process.argv[3]) throw new Error('INSTALLED_VERSION_MISMATCH');
  console.log(JSON.stringify(result));
}
module.exports = { readVersion };
