'use strict';
/**
 * Request-pipeline hardening: parser-legal-but-URL-hostile inputs must get
 * their documented refusals (403/400), never a 500, and the anti-framing
 * headers must come from the server (the <meta> CSP variant of
 * frame-ancestors is ignored by spec).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { startTarka } = require('./helpers/harness');

/** Raw request with full control of the Host header (fetch forbids overriding it). */
function rawGet(origin, pathname, host) {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: host ? { Host: host } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('a Host with URL-forbidden characters gets the documented 403, not a 500', async () => {
  const tarka = await startTarka();
  try {
    for (const host of ['evil|rebind.example', 'bad host.example', 'x<y.example']) {
      const page = await rawGet(tarka.origin, '/', host);
      assert.equal(page.status, 403, `${host} → ${page.status}`);
      assert.match(page.body, /refused/i);
      const api = await rawGet(tarka.origin, '/api/health', host);
      assert.equal(api.status, 403);
      assert.match(api.body, /Refusing request/);
    }
  } finally {
    await tarka.close();
  }
});

test('a NUL in a static path is a 400, not a crashed stat', async () => {
  const tarka = await startTarka();
  try {
    for (const p of ['/%00', '/foo%00.html']) {
      const r = await rawGet(tarka.origin, p);
      assert.equal(r.status, 400, p);
    }
    assert.equal(tarka.stderr(), '', 'no stack traces on stderr');
  } finally {
    await tarka.close();
  }
});

test('a TARKA_ALLOWED_HOSTS entry written as host:port still matches', async () => {
  const tarka = await startTarka({ TARKA_ALLOWED_HOSTS: 'proxy.example.com:8080, [2001:db8::5]:8443' });
  try {
    const r = await rawGet(tarka.origin, '/api/health', 'proxy.example.com:8080');
    assert.equal(r.status, 200, 'the allowlisted host must be trusted');
    const bare = await rawGet(tarka.origin, '/api/health', 'proxy.example.com');
    assert.equal(bare.status, 200, 'portless form of the same entry works too');
    const other = await rawGet(tarka.origin, '/api/health', 'other.example.com');
    assert.equal(other.status, 403, 'unlisted hosts stay refused');
  } finally {
    await tarka.close();
  }
});

test('anti-framing headers are sent on pages and API responses', async () => {
  const tarka = await startTarka();
  try {
    for (const p of ['/', '/api/health']) {
      const r = await rawGet(tarka.origin, p);
      assert.equal(r.headers['x-frame-options'], 'DENY', p);
      assert.match(String(r.headers['content-security-policy'] || ''), /frame-ancestors 'none'/, p);
    }
  } finally {
    await tarka.close();
  }
});
