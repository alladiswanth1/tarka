const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { PORT, HOST, REFERER_HOST } = require('./lib/config');
const { PUBLIC_DIR } = require('./lib/paths');
const { sendFile, escapeHtmlText, sendJsonRes } = require('./lib/http');
const {
  isTrustedHostHeader,
  hostnameFromHeader,
  isSameOriginRequest,
  isCsrfSafeContentType,
  isLoopbackRemote
} = require('./lib/security');
const { handleChat, handleModels } = require('./lib/proxy');
const { handleProjectRoute } = require('./lib/project/routes');
const { detectLocalAgents } = require('./lib/local-agents');

/*
 * Request pipeline, in order:
 *   1. Host header must name this machine        (anti DNS-rebinding)
 *   2. /api/* must be same-origin + JSON-shaped  (anti CSRF)
 *   3. route: /api/health · /api/chat · /api/models · /api/agents/local · /api/project*
 *   4. anything else: static file from public/, SPA fallback to index.html
 *
 * Steps 1 and 2 exist because Project Mode writes files and runs commands.
 * See lib/security.js for the reasoning behind each check.
 */

async function route(req, res) {
  // Clickjacking: index.html's <meta> CSP cannot carry frame-ancestors (the
  // spec requires browsers to IGNORE that directive in <meta>), so the
  // protection must be a response header. Sent on everything — an API JSON
  // response in a frame is equally unwanted.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

  // Untrusted Host header → refuse everything (DNS-rebinding defense).
  // Checked BEFORE URL construction: a parser-legal Host containing
  // URL-forbidden characters ("evil|rebind.example") would make `new URL`
  // throw and turn the documented 403 into a 500 with a stack trace.
  if (!isTrustedHostHeader(req)) {
    const shown = String(req.headers.host || '').slice(0, 120);
    if (String(req.url || '').startsWith('/api/')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Refusing request for Host "${shown}" — open Tarka via 127.0.0.1 or set TARKA_ALLOWED_HOSTS.`
        })
      );
    } else {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Tarka · blocked host</title>` +
          `<body style="font:15px/1.6 system-ui;background:#0a0a0d;color:#e7e7ea;padding:40px;max-width:640px;margin:auto">` +
          `<h2 style="color:#a78bfa">Tarka refused this request</h2>` +
          `<p>The <code>Host</code> header was <code>${escapeHtmlText(shown) || '(empty)'}</code>, which is not a name for this machine. ` +
          `Tarka only answers on IP addresses, <code>localhost</code>, and <code>.local</code> names so a hostile website cannot ` +
          `point its own domain at your loopback interface and drive Project Mode.</p>` +
          `<p>Open <code>http://${REFERER_HOST}:${PORT}</code> instead, or start the server with ` +
          `<code>TARKA_ALLOWED_HOSTS=${escapeHtmlText(hostnameFromHeader(shown)) || 'your.host'}</code> if this name is really yours.</p></body>`
      );
    }
    return;
  }

  // The Host is trusted here, but an allowlisted name could still carry
  // URL-hostile characters — a parse failure is the client's 400, not our 500.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    // Cross-site browser requests never reach the API: a page you visit must
    // not be able to read chats or run commands through this server.
    if (!isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-site requests are not allowed' }));
      return;
    }
    if (req.method === 'POST' && !isCsrfSafeContentType(req)) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Send this request as application/json' }));
      return;
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return handleChat(req, res);
    }

    if (url.pathname === '/api/models' && req.method === 'POST') {
      return handleModels(req, res);
    }

    if (url.pathname === '/api/agents/local' && req.method === 'GET') {
      if (!isLoopbackRemote(req)) {
        return sendJsonRes(res, 403, { error: 'Local Claude / Codex agents are available from this machine only' });
      }
      try {
        const agents = await detectLocalAgents();
        return sendJsonRes(res, 200, { agents });
      } catch (e) {
        return sendJsonRes(res, 500, { error: e.message || 'detect failed' });
      }
    }

    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/') || url.pathname.startsWith('/api/project/')) {
      return handleProjectRoute(req, res, url);
    }

    // Unknown /api/* — never fall through to SPA HTML
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Static files — decode + normalize; reject path traversal / sibling dirs
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  // A NUL in the path makes fs.stat throw synchronously (ERR_INVALID_ARG_VALUE)
  if (decodedPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!(filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // A path that names a FILE (it has an extension) and is not there is a
      // 404, not a route. Answering every miss with index.html at HTTP 200 means
      // a renamed asset loads as HTML and only fails later, somewhere else —
      // and with no build step, a stale reference is a normal kind of mistake.
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      // SPA fallback for non-API routes only
      sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    sendFile(res, filePath);
  });
}

/*
 * A single throw inside the handler used to be an unhandled rejection, which
 * Node answers by killing the process — one malformed request would take the
 * whole server (and every in-flight chat) with it. Nothing below is expected
 * to throw; this is the backstop that keeps "unexpected" from meaning "down".
 */
const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      console.error('Unhandled error while handling', req.method, req.url, '—', err);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
});

/**
 * Only a failure to START is fatal. Exiting on ANY server error would take
 * every in-flight chat down for something the process could have survived —
 * the same failure mode the route() wrapper above exists to prevent.
 */
let listening = false;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n✗ Port ${PORT} is already in use — another Tarka (or something else) is listening on ${HOST}:${PORT}.` +
        `\n  Stop it, or start this one on a different port:  PORT=3001 node server.js\n`
    );
  } else if (err.code === 'EACCES') {
    console.error(`\n✗ Not allowed to bind ${HOST}:${PORT}. Ports below 1024 need elevated privileges.\n`);
  } else {
    console.error('\n✗ Server error:', err.message, '\n');
    if (listening) return; // already serving — log it and keep serving
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  listening = true;
  console.log(`\n🚀 Tarka server running at http://${REFERER_HOST}:${PORT}`);
  console.log(`   Bound to ${HOST} (set HOST=0.0.0.0 to listen on all interfaces).\n`);
  console.log(`   Open the URL above in your browser.\n`);
  console.log(`   Configure Base URL, API Key and Model in the UI sidebar.\n`);
  console.log(`   Zero dependencies – pure Node.js.\n`);
});
