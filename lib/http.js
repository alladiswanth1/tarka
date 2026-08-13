'use strict';
/** Small HTTP helpers shared by every route: bodies, static files, SSE, JSON. */
const fs = require('fs');
const path = require('path');

// Simple MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/** Inert text for the few HTML strings this server builds itself. */
function escapeHtmlText(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // Local app: always revalidate so UI updates are never served stale
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      // 10MB: long debates on big-context models legitimately exceed 2MB
      if (size > 10 * 1024 * 1024) {
        // Stop consuming; leave the socket open so the route can send 413 JSON
        req.pause();
        const err = new Error('Request body too large (max 10MB)');
        err.statusCode = 413;
        settle(reject, err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        settle(resolve, body ? JSON.parse(body) : {});
      } catch (e) {
        settle(reject, new Error('Invalid JSON'));
      }
    });
    req.on('error', (e) => settle(reject, e));
  });
}

function writeSse(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJsonRes(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { MIME, escapeHtmlText, sendFile, parseBody, writeSse, sendJsonRes };
