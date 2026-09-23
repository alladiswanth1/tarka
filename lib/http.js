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

/**
 * Collapse a burst of token events into one SSE event.
 *
 * One upstream TCP chunk routinely carries dozens of one-token deltas, and each
 * used to leave as its own `data:` line: its own res.write, and in the browser
 * its own JSON.parse and callback round through the renderer. Adjacent
 * `content` (or `reasoning`) text is joined until flush(), which callers run at
 * the end of every upstream chunk — so no token ever waits on a later one.
 * write() flushes first, so events keep their order.
 */
function createSseCoalescer(res) {
  let type = null;
  let text = '';
  const flush = () => {
    if (type === null) return;
    const payload = { type, content: text };
    type = null;
    text = '';
    writeSse(res, payload);
  };
  return {
    /** Queue token text of a mergeable type ('content' | 'reasoning'). */
    push(kind, content) {
      if (!content) return;
      if (type !== kind) {
        flush();
        type = kind;
      }
      text += content;
    },
    /** Any other event (error, done): queued tokens go out ahead of it. */
    write(payload) {
      flush();
      writeSse(res, payload);
    },
    flush
  };
}

function sendJsonRes(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { MIME, escapeHtmlText, sendFile, parseBody, writeSse, createSseCoalescer, sendJsonRes };
