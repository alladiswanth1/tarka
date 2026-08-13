'use strict';
/**
 * Upstream-silence handling. Gateways in the one-api family send no
 * keep-alive bytes while a reasoning model thinks, so the proxy must
 * (a) survive long silent gaps up to UPSTREAM_TIMEOUT_MS,
 * (b) keep the DOWNSTREAM connection visibly alive with SSE comments, and
 * (c) time out with a message that names the phase and the env var.
 */
const test = require('node:test');
const assert = require('node:assert');

const { startMockProvider, startTarka, writeSseChunks, contentChunk } = require('./helpers/harness');

test('an upstream that never answers times out with an actionable error', async () => {
  const tarka = await startTarka({ UPSTREAM_TIMEOUT_MS: '250' });
  const provider = await startMockProvider(() => {
    /* accept the request, never respond */
  });
  try {
    const res = await tarka.post('/api/chat', {
      baseURL: provider.baseURL,
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }]
    });
    const text = await res.text();
    assert.match(text, /sent nothing for \d+s/);
    assert.match(text, /UPSTREAM_TIMEOUT_MS/);
  } finally {
    await provider.close();
    await tarka.close();
  }
});

test('a stall after data flowed is reported as mid-response, not as silence', async () => {
  const tarka = await startTarka({ UPSTREAM_TIMEOUT_MS: '250' });
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(contentChunk('partial'))}\n\n`);
    /* then hang forever */
  });
  try {
    const res = await tarka.post('/api/chat', {
      baseURL: provider.baseURL,
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }]
    });
    const text = await res.text();
    assert.match(text, /"type":"content"/);
    assert.match(text, /stalled mid-response/);
  } finally {
    await provider.close();
    await tarka.close();
  }
});

test('SSE keep-alive comments flow downstream while the upstream is silent', async () => {
  const tarka = await startTarka({ TARKA_SSE_KEEPALIVE_MS: '50', UPSTREAM_TIMEOUT_MS: '5000' });
  const provider = await startMockProvider((req, res) => {
    // Silent long enough for several keep-alive ticks, then a normal reply
    setTimeout(() => writeSseChunks(res, [contentChunk('late answer')]), 300);
  });
  try {
    const res = await tarka.post('/api/chat', {
      baseURL: provider.baseURL,
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }]
    });
    const text = await res.text();
    assert.match(text, /^: keepalive$/m, 'keep-alive comments must be sent during upstream silence');
    assert.match(text, /late answer/, 'the eventual answer still streams through');
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await provider.close();
    await tarka.close();
  }
});

test('/models honours TARKA_MODELS_TIMEOUT_MS', async () => {
  const tarka = await startTarka({ TARKA_MODELS_TIMEOUT_MS: '200' });
  const provider = await startMockProvider(() => {
    /* never respond */
  });
  try {
    const res = await tarka.post('/api/models', { baseURL: provider.baseURL, apiKey: 'sk-test' });
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /timed out/);
  } finally {
    await provider.close();
    await tarka.close();
  }
});
