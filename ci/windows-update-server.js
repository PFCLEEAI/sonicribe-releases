'use strict';
// Dependency-free loopback feed for the Windows CI runner. Never shipped.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
function serve(directory, port = 18765) {
  return http.createServer((req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
    if (!/^(?:latest\.yml|sonicribe-cloud-0\.0\.9[01]-win-x64\.exe(?:\.blockmap)?)$/.test(name)) { res.writeHead(404).end(); return; }
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) { res.writeHead(416).end(); return; }
      start = +range[1]; end = range[2] ? +range[2] : end; status = 206;
      if (start > end || end >= size) { res.writeHead(416).end(); return; }
    }
    console.log(JSON.stringify({ event: 'http-request', method: req.method, name, status, start, end, size }));
    res.writeHead(status, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
  }).listen(port, '127.0.0.1');
}
if (require.main === module) serve(path.resolve(process.argv[2]), Number(process.argv[3] || 18765));
module.exports = { serve };
