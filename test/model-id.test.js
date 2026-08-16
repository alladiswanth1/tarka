'use strict';
/**
 * One case table, run through BOTH implementations.
 *
 * The server picks a context window out of a provider catalog with its copy;
 * the browser matches the same catalog for the meter and the "unknown model"
 * warning with its own. Divergence means the badge and the warning disagree
 * about the same id, silently. This is the test that keeps them honest.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const server = require('../lib/proxy');

let client;
test.before(async () => {
  client = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'modelId.js')).href);
});

/** [a, b, related?] — covering both gateways Tarka documents. */
const PAIRS = [
  // identical
  ['gpt-4o', 'gpt-4o', true],
  ['GPT-4O', 'gpt-4o', true],
  ['  gpt-4o  ', 'gpt-4o', true],

  // OpenRouter "provider/model"
  ['moonshotai/kimi-k3', 'kimi-k3', true],
  ['kimi-k3', 'moonshotai/kimi-k3', true],
  ['openai/gpt-4o', 'gpt-4o', true],
  ['anthropic/claude-3.5-sonnet', 'claude-3.5-sonnet', true],

  // OpenRouter ":tag" variants
  ['deepseek/deepseek-r1:free', 'deepseek-r1', true],
  ['deepseek-r1', 'deepseek-r1:free', true],
  ['deepseek-r1:free', 'deepseek-r1:free', true],
  ['deepseek-r1:free', 'deepseek-r1:nitro', false],
  ['deepseek-r1:free', 'deepseek-r1:floor', false],

  // TokenRouter "provider:model"
  ['openai:gpt-4o', 'gpt-4o', true],
  ['gpt-4o', 'openai:gpt-4o', true],
  ['openai:gpt-4o', 'openai/gpt-4o', true],
  ['anthropic:claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022', true],
  ['deepseek:deepseek-chat', 'deepseek-chat', true],
  ['gemini:gemini-2.5-pro', 'gemini-2.5-pro', true],
  ['mistral:mistral-large-latest', 'mistral-large-latest', true],

  // TokenRouter routing modes are distinct products, not tags
  ['auto:balance', 'auto:cost', false],
  ['auto:fast', 'auto:quality', false],
  ['auto:balance', 'auto:balance', true],
  ['auto:balance', 'auto', false],

  // Ollama "name:size" — the tag is a VARIANT, never the model. These are the
  // one case where the right side is model-shaped (it carries a digit) but is
  // still not the model, so the provider-prefix rule used to throw the name
  // away and reduce every 7B model to the same base "7b".
  ['codellama:7b', 'mistral:7b', false],
  ['gemma:2b', 'phi:2b', false],
  ['llama3:70b', 'qwen:70b', false],
  ['mistral:q4_0', 'codellama:q4_0', false],
  ['llama3:8b', 'llama3:70b', false],
  ['codellama:7b', 'codellama:7b', true],
  ['codellama', 'codellama:7b', true],
  ['llama3', 'llama3:latest', true],
  ['llama3:1.5b', 'llama3', true],

  // near-misses that must NOT collapse
  ['gpt-4o', 'gpt-4o-mini', false],
  ['openai:gpt-4o', 'gpt-4o-mini', false],
  ['gpt-4', 'gpt-4-turbo', false],
  ['claude-3-opus', 'claude-3-sonnet', false],
  ['llama-3.1-8b', 'llama-3.1-70b', false],
  ['o1', 'o1-mini', false],
  ['openai:gpt-4o', 'anthropic:claude-3-opus', false],

  // empties
  ['', 'gpt-4o', false],
  ['gpt-4o', '', false],
  ['', '', false]
];

test('the server and the browser agree on every pair', () => {
  const disagreements = [];
  for (const [a, b, expected] of PAIRS) {
    const s = server.modelIdsRelated(a, b);
    const c = client.modelIdsRelated(a, b);
    if (s !== c) disagreements.push(`server=${s} client=${c} for ${JSON.stringify([a, b])}`);
    assert.equal(s, expected, `server: ${JSON.stringify([a, b])}`);
    assert.equal(c, expected, `client: ${JSON.stringify([a, b])}`);
  }
  assert.deepEqual(disagreements, [], `\n${disagreements.join('\n')}`);
});

test('the relation is symmetric', () => {
  for (const [a, b] of PAIRS) {
    assert.equal(
      server.modelIdsRelated(a, b),
      server.modelIdsRelated(b, a),
      `asymmetric: ${JSON.stringify([a, b])}`
    );
  }
});

test('splitModelId agrees across both implementations', () => {
  const ids = [
    ...new Set(PAIRS.flatMap(([a, b]) => [a, b])),
    'openrouter/auto',
    'x-ai/grok-3',
    'qwen/qwen-2.5-72b-instruct:free'
  ];
  for (const id of ids) {
    assert.deepEqual(client.splitModelId(id), server.splitModelId(id), id);
  }
});

test('modelMatchesCatalog is advisory, never a hard no on an empty catalog', () => {
  assert.equal(client.modelMatchesCatalog('gpt-4o', null), null);
  assert.equal(client.modelMatchesCatalog('gpt-4o', []), null);
  assert.equal(client.modelMatchesCatalog('', ['gpt-4o']), null);
  assert.equal(client.modelMatchesCatalog('gpt-4o', ['openai/gpt-4o', 'x']), true);
  assert.equal(client.modelMatchesCatalog('openai:gpt-4o', ['gpt-4o']), true);
  assert.equal(client.modelMatchesCatalog('gpt-4o-turbo', ['gpt-4o']), false);
});
