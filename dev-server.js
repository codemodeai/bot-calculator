#!/usr/bin/env node
// Local preview: serves the static site and the /api functions the same way Vercel does.
//   node dev-server.js            -> http://localhost:3000
// Put your keys in .env (see .env.example); until the panel, UPI, Gmail and Supabase keys are all set the store runs in demo mode.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PORT = Number(process.env.PORT) || 3000;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const api = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    const file = path.join(ROOT, 'api', api[1] + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
    return require(file)(req, res);
  }
  let rel = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/index';
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || /\/(\.|lib\/|api\/|data\/|tools\/|test\/|node_modules\/|supabase\/)|^\/package(-lock)?\.json$/.test(rel)) { res.statusCode = 404; return res.end('Not found'); }
  if (!path.extname(file)) file += '.html';   // cleanUrls, like vercel.json
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => {
  const mode = require('./lib/shop').mode();
  console.log('Store: http://localhost:' + PORT + '  (' + mode + ' mode)');
});
