'use strict';

// Dedicated loopback preview: serve only these design files, never a repository directory.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ...['chevron-left', 'eye', 'eye-off', 'shield-check', 'wechat', 'idle', 'verifying', 'welcomed']
    .map((name) => [`/icons/${name}.svg`, [`icons/${name}.svg`, 'image/svg+xml']]),
]);
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
  catch { res.writeHead(400).end(); return; }
  const file = files.get(pathname);
  if (!file) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(__dirname, file[0]), (error, body) => {
    if (error) { res.writeHead(500).end('Preview file unavailable'); return; }
    res.writeHead(200, {
      'Content-Type': file[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(4187, '127.0.0.1', () => console.log('Open Sound preview: http://127.0.0.1:4187'));
