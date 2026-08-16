'use strict';
/**
 * Test harness: a mock OpenAI-compatible provider plus a real Tarka server.
 *
 * Tarka runs as a child process on an ephemeral port so the tests exercise the
 * whole pipeline — host check, CSRF check, routing, proxy — not just the
 * handler in isolation. Nothing here is Tarka-specific enough to belong in lib/.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/**
 * A stand-in upstream provider.
 *
 * `handler(req, res, body)` decides the response; `server.requests` records
 * every request ({ method, url, headers, body }) so a test can assert on what
 * Tarka actually put on the wire.
 */
async function startMockProvider(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      handler(req, res, body, requests.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => server.close(r))
  };
}

/** Write an SSE stream, one `data:` line per element. */
function writeSseChunks(res, chunks, { trailingDone = true, finalNewline = true } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  for (const c of chunks) {
    res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  }
  if (trailingDone) res.write(finalNewline ? 'data: [DONE]\n\n' : 'data: [DONE]');
  res.end();
}

/** Minimal OpenAI streaming content chunk. */
function contentChunk(text) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  };
}

/** The usage chunk stream_options asks for: choices is empty, usage is set. */
function usageChunk(usage) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, ...usage }
  };
}

/** Start the real server.js on an ephemeral port and wait until it listens. */
async function startTarka(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(c.toString()));

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode != null) {
      throw new Error(`server exited (${child.exitCode}): ${stderr.join('')}`);
    }
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr.join('')}`);
    await new Promise((r) => setTimeout(r, 40));
  }

  return {
    origin,
    stderr: () => stderr.join(''),
    post: (p, body, init = {}) =>
      fetch(origin + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
        body: JSON.stringify(body),
        ...init
      }),
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode != null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      })
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Read a Tarka SSE response into the events it carried. */
async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* ignore */
    }
  }
  return {
    events,
    content: events.filter((e) => e.type === 'content').map((e) => e.content).join(''),
    reasoning: events.filter((e) => e.type === 'reasoning').map((e) => e.content).join(''),
    usages: events.filter((e) => e.type === 'done').map((e) => e.usage),
    errors: events.filter((e) => e.type === 'error').map((e) => e.error),
    sawDone: text.includes('data: [DONE]')
  };
}

module.exports = {
  startMockProvider,
  startTarka,
  writeSseChunks,
  contentChunk,
  usageChunk,
  readSse
};
