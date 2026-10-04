// Tiny request/response helpers that work on Vercel's Node runtime and in dev-server.js.
'use strict';

const { ShopError } = require('./shop');

function readRaw(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return Promise.resolve(String(req.rawBody));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) { reject(new ShopError('Request too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new ShopError('Invalid JSON.', 400); }
}

function send(res, status, data, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

// Wraps a handler: method check + JSON errors (no stack traces or secrets leak to the browser).
function handler(methods, fn) {
  return async (req, res) => {
    if (methods.indexOf(req.method) === -1) {
      return send(res, 405, { error: 'Method not allowed' }, { Allow: methods.join(', ') });
    }
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof ShopError) return send(res, e.status, Object.assign({ error: e.message }, e.extra));
      console.error(e);
      send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  };
}

module.exports = { readRaw, readJson, send, query, handler };
