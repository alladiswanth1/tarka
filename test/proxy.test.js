'use strict';
/** Pure helpers from lib/proxy.js — the provider-compat logic. */
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const {
  extractText,
  apiUrl,
  rejectsParam,
  isAzureOpenAIHost,
  upstreamHeaders,
  headerSafeApiKey,
  clampTemperature,
  clampMaxTokens,
  reasoningVariants,
  splitModelId,
  modelIdsRelated,
  pickContextLength,
  decodeBody,
  formatUpstreamHttpError
} = require('../lib/proxy');

test('formatUpstreamHttpError keeps the HTTP status on the client string', () => {
  assert.equal(
    formatUpstreamHttpError(400, JSON.stringify({ error: { message: 'model temporarily unavailable' } })),
    'Upstream HTTP 400: model temporarily unavailable'
  );
  assert.equal(
    formatUpstreamHttpError(500, JSON.stringify({ error: { message: 'Internal Server Error' } })),
    'Upstream HTTP 500: Internal Server Error'
  );
  assert.equal(formatUpstreamHttpError(503, 'Bad Gateway'), 'Upstream HTTP 503: Bad Gateway');
  assert.equal(formatUpstreamHttpError(502, ''), 'Upstream HTTP 502');
  assert.equal(
    formatUpstreamHttpError(402, JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } })),
    'Upstream HTTP 402: Insufficient credits'
  );
});

test('apiUrl appends the endpoint to the PATH, keeping Azure’s query and dropping fragments', () => {
  const u = (b, e) => apiUrl(b, e).href;
  assert.equal(u('https://openrouter.ai/api/v1', '/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(u('https://openrouter.ai/api/v1///', '/models'), 'https://openrouter.ai/api/v1/models');
  assert.equal(
    u('https://api.tokenrouter.com/v1/chat/completions', '/chat/completions'),
    'https://api.tokenrouter.com/v1/chat/completions'
  );
  assert.equal(
    u('https://acme.openai.azure.com/openai/deployments/gpt4?api-version=2024-10-21', '/chat/completions'),
    'https://acme.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21'
  );
  assert.equal(u('https://api.openai.com/v1#frag', '/models'), 'https://api.openai.com/v1/models');
  assert.throws(() => apiUrl('not a url', '/models'));
});

test('isAzureOpenAIHost matches only Azure OpenAI hostnames', () => {
  assert.equal(isAzureOpenAIHost('acme.openai.azure.com'), true);
  assert.equal(isAzureOpenAIHost('acme.cognitiveservices.azure.com'), true);
  assert.equal(isAzureOpenAIHost('api.openai.com'), false);
  assert.equal(isAzureOpenAIHost('openai.azure.com.evil.example'), false);
});

/*
 * The compat ladder must key on the parameter NAME near a rejection word. A
 * pydantic-style 422 echoes the whole request, so every field name is in the
 * body; a bare substring match walked the whole ladder for an unrelated 400.
 */
test('rejectsParam wants the parameter next to a rejection keyword', () => {
  assert.equal(rejectsParam("Unsupported parameter: 'temperature' is not supported with this model.", 'temperature'), true);
  assert.equal(rejectsParam('Unrecognized request argument supplied: reasoning', 'reasoning(?:_effort)?'), true);
  assert.equal(rejectsParam('{"error":{"message":"Unsupported value: \'max_tokens\'"}}', 'max_tokens'), true);
  assert.equal(rejectsParam('extra_forbidden: stream_options', 'stream_options|include_usage'), true);
  const echoed =
    '{"detail":[{"type":"value_error","msg":"Invalid role alternation","input":{"model":"x","stream_options":{"include_usage":true},"temperature":0.7,"reasoning":{"effort":"high"},"max_tokens":100}}]}';
  assert.equal(rejectsParam(echoed, 'temperature'), false);
  assert.equal(rejectsParam(echoed, 'reasoning(?:_effort)?'), false);
  assert.equal(rejectsParam(echoed, 'stream_options|include_usage'), false);
  assert.equal(rejectsParam(echoed, 'max_tokens'), false);
  // pydantic extra_forbidden names the field in `loc`, not as a key
  const loc = '{"detail":[{"type":"extra_forbidden","loc":["body","reasoning"],"msg":"Extra inputs are not permitted","input":{"effort":"high"}}]}';
  assert.equal(rejectsParam(loc, 'reasoning(?:_effort)?'), true);
  assert.equal(rejectsParam(loc, 'temperature'), false);
});

test('headerSafeApiKey rejects keys http.request would throw on', () => {
  assert.equal(headerSafeApiKey('sk-abc123'), 'sk-abc123');
  assert.equal(headerSafeApiKey('  sk-abc123\n'), 'sk-abc123'); // the common paste
  assert.equal(headerSafeApiKey(''), null);
  assert.equal(headerSafeApiKey(null), null);
  assert.equal(headerSafeApiKey('sk-abc\ndef'), null); // embedded newline: header injection
  assert.equal(headerSafeApiKey('sk-abc\rdef'), null);
  assert.equal(headerSafeApiKey('sk-ключ'), null); // outside printable Latin-1
});

test('clampTemperature: null/"" mean unset, explicit 0 is honoured', () => {
  assert.equal(clampTemperature(null), 0.7);
  assert.equal(clampTemperature(undefined), 0.7);
  assert.equal(clampTemperature(''), 0.7);
  assert.equal(clampTemperature('abc'), 0.7);
  assert.equal(clampTemperature(0), 0); // NOT coerced back to 0.7
  assert.equal(clampTemperature(1.5), 1.5);
  assert.equal(clampTemperature(9), 2);
  assert.equal(clampTemperature(-3), 0);
});

test('clampMaxTokens', () => {
  assert.equal(clampMaxTokens(null), undefined);
  assert.equal(clampMaxTokens(''), undefined);
  assert.equal(clampMaxTokens(0), undefined);
  assert.equal(clampMaxTokens(-5), undefined);
  assert.equal(clampMaxTokens('abc'), undefined);
  assert.equal(clampMaxTokens(1024), 1024);
  assert.equal(clampMaxTokens('2048'), 2048);
  assert.equal(clampMaxTokens(1500.9), 1500);
  assert.equal(clampMaxTokens(9e9), 2_000_000);
});

test('reasoningVariants: OpenAI-native hosts get reasoning_effort first', () => {
  for (const host of ['api.openai.com', 'openai.com', 'my.openai.azure.com', 'x.cognitiveservices.azure.com']) {
    const v = reasoningVariants('high', host);
    assert.deepEqual(v.map((x) => x.style), ['native', 'router', null], host);
  }
});

test('reasoningVariants: gateways get the router shape first', () => {
  for (const host of ['openrouter.ai', 'api.tokenrouter.com', 'api.together.xyz', 'localhost']) {
    const v = reasoningVariants('high', host);
    assert.deepEqual(v.map((x) => x.style), ['router', 'native', null], host);
  }
});

test('reasoningVariants: effort none/empty means no reasoning field at all', () => {
  for (const e of ['none', '', null, undefined]) {
    const v = reasoningVariants(e, 'openrouter.ai');
    assert.equal(v.length, 1);
    const body = {};
    v[0].apply(body);
    assert.deepEqual(body, {});
  }
});

test('reasoningVariants: the two shapes match each provider’s documented field', () => {
  const [router, native] = reasoningVariants('high', 'openrouter.ai');
  const rb = {};
  router.apply(rb);
  assert.deepEqual(rb, { reasoning: { effort: 'high' } }); // OpenRouter reasoning object
  const nb = {};
  native.apply(nb);
  assert.deepEqual(nb, { reasoning_effort: 'high' }); // OpenAI top-level field

  // OpenRouter accepts "max"; OpenAI does not, so native maps it down
  const maxRouter = {};
  reasoningVariants('max', 'openrouter.ai')[0].apply(maxRouter);
  assert.deepEqual(maxRouter, { reasoning: { effort: 'max' } });
  const maxNative = {};
  reasoningVariants('max', 'api.openai.com')[0].apply(maxNative);
  assert.deepEqual(maxNative, { reasoning_effort: 'high' });
});

test('splitModelId: OpenRouter "/" prefix and ":" tag', () => {
  assert.deepEqual(splitModelId('moonshotai/kimi-k3'), { base: 'kimi-k3', tag: '' });
  assert.deepEqual(splitModelId('deepseek/deepseek-r1:free'), { base: 'deepseek-r1', tag: 'free' });
  assert.deepEqual(splitModelId('gpt-4o'), { base: 'gpt-4o', tag: '' });
});

test('splitModelId: TokenRouter "provider:model" prefix', () => {
  assert.deepEqual(splitModelId('openai:gpt-4o'), { base: 'gpt-4o', tag: '' });
  assert.deepEqual(splitModelId('anthropic:claude-3-5-sonnet-20241022'), {
    base: 'claude-3-5-sonnet-20241022',
    tag: ''
  });
  assert.deepEqual(splitModelId('deepseek:deepseek-chat'), { base: 'deepseek-chat', tag: '' });
});

test('splitModelId: ambiguous ids stay intact', () => {
  // TokenRouter routing modes — neither side is model-shaped
  for (const id of ['auto:balance', 'auto:fast', 'auto:cost', 'auto:quality']) {
    assert.deepEqual(splitModelId(id), { base: id, tag: '' }, id);
  }
});

test('modelIdsRelated: aliases match across both prefix conventions', () => {
  const yes = [
    ['gpt-4o', 'gpt-4o'],
    ['moonshotai/kimi-k3', 'kimi-k3'],
    ['kimi-k3', 'moonshotai/kimi-k3'],
    ['openai:gpt-4o', 'gpt-4o'],
    ['openai:gpt-4o', 'openai/gpt-4o'],
    ['deepseek-r1', 'deepseek-r1:free'],
    ['deepseek/deepseek-r1:free', 'deepseek-r1'],
    ['GPT-4O', 'gpt-4o'] // case-insensitive
  ];
  for (const [a, b] of yes) assert.equal(modelIdsRelated(a, b), true, `${a} ~ ${b}`);
});

test('modelIdsRelated: different products never collapse', () => {
  const no = [
    ['gpt-4o', 'gpt-4o-mini'],
    ['openai:gpt-4o', 'gpt-4o-mini'],
    ['claude-3-opus', 'claude-3-sonnet'],
    ['deepseek-r1:free', 'deepseek-r1:nitro'], // two DIFFERENT tags
    ['auto:balance', 'auto:cost'],
    ['auto:fast', 'auto:quality'],
    ['gpt-4', 'gpt-4-turbo'],
    ['', 'gpt-4o'],
    ['gpt-4o', '']
  ];
  for (const [a, b] of no) assert.equal(modelIdsRelated(a, b), false, `${a} !~ ${b}`);
});

test('pickContextLength: explicit context fields win', () => {
  // OpenRouter shape
  assert.equal(
    pickContextLength({
      id: 'moonshotai/kimi-k3',
      context_length: 131072,
      top_provider: { context_length: 131072, max_completion_tokens: 4096 }
    }),
    131072
  );
  assert.equal(pickContextLength({ context_window: 200000 }), 200000);
  assert.equal(pickContextLength({ max_model_len: 32768 }), 32768); // vLLM
  assert.equal(pickContextLength({ n_ctx: 8192 }), 8192); // llama.cpp
  assert.equal(pickContextLength({ max_input_tokens: 1000000 }), 1000000);
  assert.equal(pickContextLength({ top_provider: { context_length: 64000 } }), 64000);
  assert.equal(pickContextLength({ limits: { max_context_tokens: 16384 } }), 16384);
});

test('pickContextLength: an ambiguous max_tokens is NOT read as a context window', () => {
  // A completion cap reported as max_tokens used to pin the meter at 4k,
  // fire "context nearly full" on message one, and shred every debate prompt.
  assert.equal(pickContextLength({ id: 'x', max_tokens: 4096 }), null);
  assert.equal(pickContextLength({ id: 'x', max_tokens: 8192 }), null);
  assert.equal(pickContextLength({ id: 'x', max_tokens: 16384 }), null);
});

test('pickContextLength: max_tokens is trusted once disambiguated', () => {
  // A sibling completion-cap field proves max_tokens is not the cap
  assert.equal(pickContextLength({ max_tokens: 8192, max_completion_tokens: 4096 }), 8192);
  assert.equal(pickContextLength({ max_tokens: 200000, max_output_tokens: 8192 }), 200000);
  // ...or it is simply too big to be one
  assert.equal(pickContextLength({ max_tokens: 128000 }), 128000);
  assert.equal(pickContextLength({ meta: { max_tokens: 65536 } }), 65536);
});

test('pickContextLength: nothing usable returns null, not a guess', () => {
  assert.equal(pickContextLength({ id: 'gpt-4o', object: 'model', owned_by: 'openai' }), null);
  assert.equal(pickContextLength({}), null);
  assert.equal(pickContextLength(null), null);
  assert.equal(pickContextLength('nope'), null);
  assert.equal(pickContextLength({ context_length: 0 }), null);
  assert.equal(pickContextLength({ context_length: 'many' }), null);
});

test('extractText handles every content shape providers send', () => {
  assert.equal(extractText('hi'), 'hi');
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
  assert.equal(extractText(['a', 'b']), 'ab');
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(extractText({ text: 'x' }), 'x');
  assert.equal(extractText({ content: 'y' }), 'y');
});

test('extractText reads OpenRouter reasoning_details without leaking blobs', () => {
  const details = [
    { type: 'reasoning.text', text: 'step one ', id: 'r1', format: 'anthropic-claude-v1' },
    { type: 'reasoning.text', text: 'step two' }
  ];
  assert.equal(extractText(details), 'step one step two');

  // A summary block is readable prose — take it
  assert.equal(extractText([{ type: 'reasoning.summary', summary: 'thought about X' }]), 'thought about X');

  // An encrypted block is opaque base64 — dropping it beats printing it
  assert.equal(extractText([{ type: 'reasoning.encrypted', data: 'ZW5jcnlwdGVk' }]), '');
});

test('decodeBody handles identity, gzip and deflate', () => {
  const json = JSON.stringify({ data: [{ id: 'gpt-4o' }] });
  assert.equal(decodeBody(Buffer.from(json), undefined), json);
  assert.equal(decodeBody(Buffer.from(json), ''), json);
  assert.equal(decodeBody(zlib.gzipSync(json), 'gzip'), json);
  assert.equal(decodeBody(zlib.gzipSync(json), 'GZIP'), json);
  assert.equal(decodeBody(zlib.deflateSync(json), 'deflate'), json);
  assert.equal(decodeBody(zlib.brotliCompressSync(json), 'br'), json);
});

test('decodeBody refuses a compression bomb instead of exhausting memory', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61)); // 64MB of "a"
  assert.throws(() => decodeBody(bomb, 'gzip'));
});

test('upstreamHeaders sends api-key only to Azure and carries the request shape', () => {
  const azure = upstreamHeaders(new URL('https://acme.openai.azure.com/openai/deployments/x'), 'k1', {
    accept: 'text/event-stream',
    encoding: 'identity',
    contentLength: 42
  });
  assert.equal(azure['api-key'], 'k1');
  assert.equal(azure.Authorization, 'Bearer k1');
  assert.equal(azure.Accept, 'text/event-stream');
  assert.equal(azure['Accept-Encoding'], 'identity');
  assert.equal(azure['Content-Type'], 'application/json');
  assert.equal(azure['Content-Length'], 42);
  const openai = upstreamHeaders(new URL('https://api.openai.com/v1'), 'k2', { accept: 'application/json', encoding: 'gzip, deflate' });
  assert.equal('api-key' in openai, false);
  assert.equal(openai.Authorization, 'Bearer k2');
  assert.equal('Content-Length' in openai, false, 'a GET carries no body headers');
  assert.equal(openai['HTTP-Referer'] && openai['X-Title'] ? true : false, true, 'attribution headers ride along');
});
