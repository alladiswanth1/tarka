'use strict';
/**
 * End-to-end /api/chat against a mock OpenAI-compatible provider.
 *
 * These run the real server.js, so they cover the host/CSRF checks and the
 * routing as well as the proxy. What they mostly exist for is the wire shape:
 * what Tarka sends upstream, and what it forwards back.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  startMockProvider,
  startTarka,
  writeSseChunks,
  contentChunk,
  usageChunk,
  readSse
} = require('./helpers/harness');

let tarka;
test.before(async () => {
  tarka = await startTarka();
});
test.after(async () => {
  if (tarka) await tarka.close();
});

const chat = (provider, extra = {}) =>
  tarka.post('/api/chat', {
    baseURL: provider.baseURL,
    apiKey: 'sk-test',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra
  });

test('a plain streaming turn round-trips content and usage', async () => {
  const provider = await startMockProvider((req, res) => {
    writeSseChunks(res, [contentChunk('Hello'), contentChunk(' world'), usageChunk()]);
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'Hello world');
    assert.deepEqual(out.usages, [{ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }]);
    assert.equal(out.errors.length, 0);
    assert.ok(out.sawDone, 'client must still receive [DONE]');
  } finally {
    await provider.close();
  }
});

/*
 * Regression: without stream_options, OpenAI and everything that copies its
 * API (Azure, vLLM, Together, Fireworks, DeepSeek, Groq, Ollama's shim) stream
 * the answer and then never report usage — so the context meter runs on
 * character-count estimates forever and "last in→out" never appears.
 */
test('stream_options.include_usage is requested upstream', async () => {
  const provider = await startMockProvider((req, res) => {
    writeSseChunks(res, [contentChunk('ok'), usageChunk()]);
  });
  try {
    await readSse(await chat(provider));
    const sent = provider.requests[0].body;
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.equal(sent.stream, true);
  } finally {
    await provider.close();
  }
});

test('a gateway that rejects stream_options gets one transparent retry without it', async () => {
  const provider = await startMockProvider((req, res, body, n) => {
    if (n === 1) {
      assert.ok(body.stream_options, 'first attempt should carry stream_options');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unrecognized request argument: stream_options" } }));
      return;
    }
    assert.equal(body.stream_options, undefined, 'retry must drop it');
    writeSseChunks(res, [contentChunk('recovered')]);
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'recovered');
    assert.equal(out.errors.length, 0, 'the user should never see this');
    assert.equal(provider.requests.length, 2, 'exactly one retry');
  } finally {
    await provider.close();
  }
});

test('the usage chunk’s empty choices array does not break content parsing', async () => {
  const provider = await startMockProvider((req, res) => {
    // Exactly the documented OpenAI shape: choices: [] on the usage chunk
    writeSseChunks(res, [contentChunk('a'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]);
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'a');
    assert.deepEqual(out.usages, [{ prompt_tokens: 3, completion_tokens: 1 }]);
  } finally {
    await provider.close();
  }
});

/*
 * Regression: some gateways attach a running `usage` to EVERY chunk. Forwarding
 * each one made the debate arena (which sums what it receives) over-report
 * token spend by a factor of the chunk count.
 */
test('a per-chunk running usage is collapsed to one final figure', async () => {
  const provider = await startMockProvider((req, res) => {
    writeSseChunks(res, [
      { choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      { choices: [{ delta: { content: 'c' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }
    ]);
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'abc');
    assert.equal(out.usages.length, 1, 'exactly one usage event');
    assert.deepEqual(out.usages[0], { prompt_tokens: 10, completion_tokens: 3 }, 'the last figures win');
  } finally {
    await provider.close();
  }
});

/*
 * Regression: the final event used to be dropped when a provider ended the body
 * without a trailing blank line — and with stream_options that final event is
 * the usage chunk.
 */
test('a last event with no trailing newline is still parsed', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(contentChunk('x'))}\n\n`);
    res.write(`data: ${JSON.stringify(usageChunk({ prompt_tokens: 42 }))}`); // no \n\n
    res.end();
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'x');
    assert.equal(out.usages.length, 1);
    assert.equal(out.usages[0].prompt_tokens, 42);
  } finally {
    await provider.close();
  }
});

test('reasoning is forwarded from every field name providers use', async () => {
  const cases = [
    { delta: { reasoning: 'R1' } },
    { delta: { reasoning_content: 'R2' } },
    { delta: { thinking: 'R3' } },
    { delta: { reasoning_details: [{ type: 'reasoning.text', text: 'R4' }] } }
  ];
  for (const c of cases) {
    const provider = await startMockProvider((req, res) => {
      writeSseChunks(res, [{ choices: [c] }, contentChunk('done')]);
    });
    try {
      const out = await readSse(await chat(provider));
      assert.match(out.reasoning, /^R[1-4]$/, JSON.stringify(c));
      assert.equal(out.content, 'done');
    } finally {
      await provider.close();
    }
  }
});

test('OpenRouter sends reasoning and reasoning_details together — no duplication', async () => {
  const provider = await startMockProvider((req, res) => {
    writeSseChunks(res, [
      {
        choices: [{
          delta: {
            reasoning: 'thinking...',
            reasoning_details: [{ type: 'reasoning.text', text: 'thinking...' }]
          }
        }]
      },
      contentChunk('answer')
    ]);
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.reasoning, 'thinking...', 'must not be emitted twice');
  } finally {
    await provider.close();
  }
});

test('the reasoning shape ladder walks router → native → none', async () => {
  const provider = await startMockProvider((req, res, body, n) => {
    if (n === 1) {
      assert.deepEqual(body.reasoning, { effort: 'high' });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning" } }));
      return;
    }
    if (n === 2) {
      assert.equal(body.reasoning, undefined);
      assert.equal(body.reasoning_effort, 'high');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }));
      return;
    }
    assert.equal(body.reasoning, undefined);
    assert.equal(body.reasoning_effort, undefined);
    writeSseChunks(res, [contentChunk('bare')]);
  });
  try {
    const out = await readSse(await chat(provider, { reasoningEffort: 'high' }));
    assert.equal(out.content, 'bare');
    assert.equal(provider.requests.length, 3);
  } finally {
    await provider.close();
  }
});

test('max_tokens is re-sent as max_completion_tokens when rejected', async () => {
  const provider = await startMockProvider((req, res, body, n) => {
    if (n === 1) {
      assert.equal(body.max_tokens, 500);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }));
      return;
    }
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, 500);
    writeSseChunks(res, [contentChunk('ok')]);
  });
  try {
    const out = await readSse(await chat(provider, { max_tokens: 500 }));
    assert.equal(out.content, 'ok');
  } finally {
    await provider.close();
  }
});

test('an unsupported temperature is dropped rather than failing the turn', async () => {
  const provider = await startMockProvider((req, res, body, n) => {
    if (n === 1) {
      assert.equal(body.temperature, 0.3);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model." } }));
      return;
    }
    assert.equal(body.temperature, undefined);
    writeSseChunks(res, [contentChunk('ok')]);
  });
  try {
    const out = await readSse(await chat(provider, { temperature: 0.3 }));
    assert.equal(out.content, 'ok');
  } finally {
    await provider.close();
  }
});

test('the attribution headers OpenRouter documents are sent', async () => {
  const provider = await startMockProvider((req, res) => writeSseChunks(res, [contentChunk('ok')]));
  try {
    await readSse(await chat(provider));
    const h = provider.requests[0].headers;
    assert.equal(h.authorization, 'Bearer sk-test');
    assert.ok(h['http-referer'], 'HTTP-Referer identifies the app to the gateway');
    assert.equal(h['x-openrouter-title'], 'Tarka');
    assert.equal(h['x-title'], 'Tarka'); // legacy name, still read
    assert.equal(h.accept, 'text/event-stream');
  } finally {
    await provider.close();
  }
});

test('a non-streaming JSON reply is still surfaced', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'not streamed' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'not streamed');
    assert.equal(out.usages.length, 1);
  } finally {
    await provider.close();
  }
});

test('a provider error message reaches the user verbatim', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }));
  });
  try {
    const out = await readSse(await chat(provider));
    assert.deepEqual(out.errors, ['Insufficient credits']);
    assert.equal(provider.requests.length, 1, 'a 402 is not a parameter problem — no retry');
  } finally {
    await provider.close();
  }
});

test('the TokenRouter error envelope is unwrapped correctly', async () => {
  // Exactly what api.tokenrouter.com returns for a missing token
  const provider = await startMockProvider((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { code: '', message: 'Token not provided (request id: 2026...)', type: 'api_error' }
    }));
  });
  try {
    const out = await readSse(await chat(provider));
    assert.match(out.errors[0], /^Token not provided/);
  } finally {
    await provider.close();
  }
});

test('a 404 on a base URL without /v1 says so', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not Found' } }));
  });
  try {
    const res = await tarka.post('/api/chat', {
      baseURL: provider.baseURL.replace(/\/v1$/, ''),
      apiKey: 'sk-test',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }]
    });
    const out = await readSse(res);
    assert.match(out.errors[0], /missing “\/v1”/);
  } finally {
    await provider.close();
  }
});

test('input validation happens before anything reaches the wire', async () => {
  const provider = await startMockProvider((req, res) => writeSseChunks(res, [contentChunk('x')]));
  try {
    const noKey = await tarka.post('/api/chat', {
      baseURL: provider.baseURL, model: 'm', messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(noKey.status, 400);
    assert.match((await noKey.json()).error, /API key is required/);

    const badKey = await tarka.post('/api/chat', {
      baseURL: provider.baseURL, apiKey: 'sk\nbad', model: 'm', messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(badKey.status, 400);
    assert.match((await badKey.json()).error, /cannot be sent in a header/);

    const noMsgs = await tarka.post('/api/chat', {
      baseURL: provider.baseURL, apiKey: 'sk-test', model: 'm', messages: []
    });
    assert.equal(noMsgs.status, 400);

    const badMsg = await tarka.post('/api/chat', {
      baseURL: provider.baseURL, apiKey: 'sk-test', model: 'm', messages: [{ role: 'user', content: 42 }]
    });
    assert.equal(badMsg.status, 400);
    assert.match((await badMsg.json()).error, /Invalid message at index 0/);

    assert.equal(provider.requests.length, 0, 'nothing should have been proxied');
  } finally {
    await provider.close();
  }
});

test('the system prompt is prepended only when the caller did not send one', async () => {
  const provider = await startMockProvider((req, res) => writeSseChunks(res, [contentChunk('x')]));
  try {
    await readSse(await chat(provider, { systemPrompt: 'Be terse.' }));
    assert.deepEqual(provider.requests[0].body.messages[0], { role: 'system', content: 'Be terse.' });

    await readSse(await chat(provider, {
      systemPrompt: 'Be terse.',
      messages: [{ role: 'system', content: 'Already here.' }, { role: 'user', content: 'hi' }]
    }));
    const msgs = provider.requests[1].body.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'Already here.');
  } finally {
    await provider.close();
  }
});

test('a body that is valid JSON but not an object does not crash the route', async () => {
  for (const raw of ['null', 'true', '[1,2]', '"hi"']) {
    const res = await fetch(tarka.origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw
    });
    assert.equal(res.status, 400, raw);
  }
});

test('cross-site requests and form-shaped bodies are refused', async () => {
  const bad = await fetch(tarka.origin + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}'
  });
  assert.equal(bad.status, 403);

  const form = await fetch(tarka.origin + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}'
  });
  assert.equal(form.status, 415);
});

test('an untrusted Host header is refused (DNS rebinding)', async () => {
  // fetch() treats Host as a forbidden header and drops it, so this needs a
  // raw request — which is also what an attacker's rebound page would send.
  const { port } = new URL(tarka.origin);
  const status = await new Promise((resolve, reject) => {
    const rq = require('http').request(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { Host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    rq.on('error', reject);
    rq.end();
  });
  assert.equal(status, 403);
});

test('an unknown /api route 404s as JSON rather than falling through to the SPA', async () => {
  const res = await fetch(tarka.origin + '/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
});

/*
 * SSE says an event may span several `data:` lines, joined with newlines and
 * delivered on the blank line. Parsing each line alone dropped every event from
 * a provider that pretty-prints its JSON — silently, because a partial parse
 * looks exactly like a partial line.
 */
test('an event split across several data: lines is reassembled', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const pretty = JSON.stringify(contentChunk('Hello'), null, 2);
    for (const line of pretty.split('\n')) res.write(`data: ${line}\n`);
    res.write('\n');
    // ...and a single-line event still works in the same stream, with no blank
    // line between it and the next — which is what real providers send.
    res.write(`data: ${JSON.stringify(contentChunk(' world'))}\n\n`);
    res.write(`data: ${JSON.stringify(usageChunk())}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const out = await readSse(await chat(provider));
    assert.equal(out.content, 'Hello world');
    assert.deepEqual(out.usages, [{ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }]);
  } finally {
    await provider.close();
  }
});

/*
 * Regression: the handlers wrote the 413 and then immediately destroyed the
 * socket while the client was still uploading, which RSTs the connection and
 * discards the reply — the user saw a generic "Failed to fetch" instead of the
 * size message. parseBody pauses the stream precisely so this is deliverable.
 */
test('an oversized body gets the documented 413, not a dropped connection', async () => {
  const body = JSON.stringify({
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }]
  });
  for (const path of ['/api/chat', '/api/models']) {
    const res = await fetch(tarka.origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    assert.equal(res.status, 413, path);
    assert.match((await res.json()).error, /too large/i, path);
  }
});

/*
 * Regression: /models has always capped the body it buffers, but the chat path
 * did not. An SSE line only leaves the buffer when its newline arrives, so an
 * upstream streaming megabytes without one grew it unboundedly — and since
 * every byte counts as activity, the idle timeout never fired either. The Base
 * URL is user-supplied, so "the upstream" is not necessarily a real provider.
 */
test('an SSE line with no newline is cut off instead of buffered forever', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    // 9MB of a single unterminated data: line — one megabyte at a time so the
    // test does not allocate the whole thing up front.
    res.write('data: ');
    let sent = 0;
    const pump = () => {
      if (sent >= 9 && !res.writableEnded) return res.end();
      if (res.writableEnded) return;
      sent++;
      res.write('x'.repeat(1024 * 1024), pump);
    };
    pump();
  });
  try {
    const out = await readSse(await chat(provider));
    assert.match(out.errors.join(' '), /oversized SSE line/i);
  } finally {
    await provider.close();
  }
});

test('an oversized non-streaming JSON reply is refused, not swallowed whole', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"choices":[{"message":{"content":"');
    let sent = 0;
    const pump = () => {
      if (sent >= 9 && !res.writableEnded) return res.end('"}}]}');
      if (res.writableEnded) return;
      sent++;
      res.write('x'.repeat(1024 * 1024), pump);
    };
    pump();
  });
  try {
    const out = await readSse(await chat(provider));
    assert.match(out.errors.join(' '), /larger than 8MB/i);
  } finally {
    await provider.close();
  }
});
