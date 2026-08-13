'use strict';
/**
 * End-to-end /api/models. The catalogs below are the real response shapes of
 * the two gateways Tarka names in its docs, which is what the context meter
 * and every debate/project seat budget ultimately read their window from.
 */
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { startMockProvider, startTarka } = require('./helpers/harness');

let tarka;
test.before(async () => {
  tarka = await startTarka();
});
test.after(async () => {
  if (tarka) await tarka.close();
});

const json = (res, obj, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
};

const ask = async (provider, extra = {}) => {
  const res = await tarka.post('/api/models', {
    baseURL: provider.baseURL,
    apiKey: 'sk-test',
    ...extra
  });
  return res.json();
};

// https://openrouter.ai/api/v1/models
const OPENROUTER = {
  data: [
    {
      id: 'moonshotai/kimi-k3',
      name: 'MoonshotAI: Kimi K3',
      context_length: 131072,
      architecture: { modality: 'text->text' },
      pricing: { prompt: '0.0000006', completion: '0.0000025' },
      top_provider: { context_length: 131072, max_completion_tokens: 8192, is_moderated: false },
      supported_parameters: ['temperature', 'reasoning', 'max_tokens']
    },
    {
      id: 'deepseek/deepseek-r1:free',
      context_length: 163840,
      top_provider: { context_length: 163840, max_completion_tokens: 4096 }
    },
    { id: 'openai/gpt-4o', context_length: 128000, top_provider: { context_length: 128000 } },
    { id: 'openai/gpt-4o-mini', context_length: 128000 }
  ]
};

// api.tokenrouter.com — an OpenAI-shaped list with no context fields at all
const TOKENROUTER = {
  object: 'list',
  data: [
    { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'openai' },
    { id: 'claude-sonnet-4-5', object: 'model', created: 1715367049, owned_by: 'anthropic' },
    { id: 'auto:balance', object: 'model', created: 1715367049, owned_by: 'tokenrouter' }
  ]
};

test('an OpenRouter catalog yields per-model context windows', async () => {
  const provider = await startMockProvider((req, res) => json(res, OPENROUTER));
  try {
    const data = await ask(provider);
    assert.equal(data.ok, true);
    assert.equal(data.count, 4);
    assert.equal(data.truncated, false);
    const byId = Object.fromEntries(data.models.map((m) => [m.id, m.context]));
    assert.equal(byId['moonshotai/kimi-k3'], 131072);
    assert.equal(byId['deepseek/deepseek-r1:free'], 163840);
    assert.equal(byId['openai/gpt-4o'], 128000);
    // max_completion_tokens must never be mistaken for the window
    assert.notEqual(byId['moonshotai/kimi-k3'], 8192);
  } finally {
    await provider.close();
  }
});

test('the requested model resolves through an alias', async () => {
  const provider = await startMockProvider((req, res) => json(res, OPENROUTER));
  try {
    for (const model of ['moonshotai/kimi-k3', 'kimi-k3']) {
      const data = await ask(provider, { model });
      assert.equal(data.context, 131072, model);
      assert.equal(data.matchedId, 'moonshotai/kimi-k3', model);
    }
    // ":free" tag variant resolves from the untagged id
    const tagged = await ask(provider, { model: 'deepseek-r1' });
    assert.equal(tagged.context, 163840);
  } finally {
    await provider.close();
  }
});

test('a near-miss id does not borrow another model’s window', async () => {
  const provider = await startMockProvider((req, res) => json(res, OPENROUTER));
  try {
    const data = await ask(provider, { model: 'gpt-4o-turbo-preview' });
    assert.equal(data.context, null);
    assert.equal(data.matchedId, null);
  } finally {
    await provider.close();
  }
});

test('a TokenRouter provider:model id matches its bare catalog entry', async () => {
  const provider = await startMockProvider((req, res) => json(res, TOKENROUTER));
  try {
    const data = await ask(provider, { model: 'openai:gpt-4o' });
    assert.equal(data.ok, true);
    assert.equal(data.count, 3);
    // The gateway reports no windows, so there is nothing to return — but the
    // id must still have been understood, not treated as an unknown product.
    assert.equal(data.context, null);
    const ids = data.models.map((m) => m.id);
    assert.deepEqual(ids, ['gpt-4o', 'claude-sonnet-4-5', 'auto:balance']);
    assert.deepEqual(data.models.map((m) => m.context), [null, null, null]);
  } finally {
    await provider.close();
  }
});

test('a bare list and a { models: [...] } envelope are both accepted', async () => {
  for (const payload of [
    [{ id: 'a', context_length: 4096 }],
    { models: [{ id: 'a', context_length: 4096 }] }
  ]) {
    const provider = await startMockProvider((req, res) => json(res, payload));
    try {
      const data = await ask(provider, { model: 'a' });
      assert.equal(data.ok, true);
      assert.equal(data.context, 4096);
    } finally {
      await provider.close();
    }
  }
});

test('a gzipped catalog is decoded', async () => {
  const provider = await startMockProvider((req, res) => {
    assert.match(String(req.headers['accept-encoding'] || ''), /gzip/);
    json(res, zlib.gzipSync(JSON.stringify(OPENROUTER)), { 'Content-Encoding': 'gzip' });
  });
  try {
    const data = await ask(provider, { model: 'openai/gpt-4o' });
    assert.equal(data.ok, true);
    assert.equal(data.context, 128000);
  } finally {
    await provider.close();
  }
});

test('a catalog larger than the send cap reports the real count', async () => {
  const big = { data: Array.from({ length: 4200 }, (_, i) => ({ id: `m-${i}`, context_length: 8192 })) };
  const provider = await startMockProvider((req, res) => json(res, big));
  try {
    const data = await ask(provider);
    assert.equal(data.count, 4200, 'the true total is always reported');
    assert.equal(data.truncated, true);
    assert.ok(data.models.length >= 4000, 'the cap must not be the old 500');
  } finally {
    await provider.close();
  }
});

test('upstream failures surface as ok:false, never as a thrown route', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  try {
    const data = await ask(provider);
    assert.equal(data.ok, false);
    assert.equal(data.status, 401);
    assert.match(data.error, /Invalid API key/);
    assert.deepEqual(data.models, []);
  } finally {
    await provider.close();
  }
});

test('a non-JSON body is reported rather than crashing', async () => {
  const provider = await startMockProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('<html>proxy error</html>');
  });
  try {
    const data = await ask(provider);
    assert.equal(data.ok, false);
    assert.match(data.error, /Invalid JSON/);
  } finally {
    await provider.close();
  }
});

test('malformed entries are skipped, not fatal', async () => {
  const provider = await startMockProvider((req, res) =>
    json(res, { data: [null, 'string', { no_id: 1 }, { id: 'good', context_length: 2048 }] })
  );
  try {
    const data = await ask(provider, { model: 'good' });
    assert.equal(data.ok, true);
    assert.deepEqual(data.models.map((m) => m.id), ['good']);
    assert.equal(data.context, 2048);
  } finally {
    await provider.close();
  }
});

test('/api/models requires an API key and rejects an unsendable one', async () => {
  const provider = await startMockProvider((req, res) => json(res, OPENROUTER));
  try {
    const noKey = await (await tarka.post('/api/models', { baseURL: provider.baseURL })).json();
    assert.equal(noKey.ok, false);
    assert.match(noKey.error, /API key is required/);

    const badKey = await (
      await tarka.post('/api/models', { baseURL: provider.baseURL, apiKey: 'sk\nbad' })
    ).json();
    assert.equal(badKey.ok, false);
    assert.match(badKey.error, /cannot be sent in a header/);

    assert.equal(provider.requests.length, 0);
  } finally {
    await provider.close();
  }
});
