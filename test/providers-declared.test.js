'use strict';
/**
 * OpenClaw-style declared models on a provider profile: the profile itself
 * states each model's context window, for gateways whose /models publishes
 * none. Parsing must round-trip the editor text, and lookup must use the same
 * segment-aware id equivalence as the rest of the app.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let P;
test.before(async () => {
  P = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'providers.js')).href);
});

test('parseDeclaredModels reads ids with ":" and "/", k/M suffixes, comments', () => {
  const parsed = P.parseDeclaredModels(
    [
      '# gateways in the one-api family hide context',
      'openai:gpt-5 = 400k',
      'moonshotai/kimi-k3 131072',
      'anthropic:claude-sonnet-4-5=200k',
      'big-model 2M',
      '',
      'not a real line',
      'too-small = 12'
    ].join('\n')
  );
  assert.deepEqual(parsed, [
    { id: 'openai:gpt-5', context: 400000 },
    { id: 'moonshotai/kimi-k3', context: 131072 },
    { id: 'anthropic:claude-sonnet-4-5', context: 200000 },
    { id: 'big-model', context: 2000000 }
  ]);
});

test('formatDeclaredModels round-trips through parse', () => {
  const models = [
    { id: 'openai:gpt-5', context: 400000 },
    { id: 'x/y-1', context: 131072 },
    { id: 'big', context: 2000000 }
  ];
  const text = P.formatDeclaredModels(models);
  assert.deepEqual(P.parseDeclaredModels(text), models);
});

test('declaredContextFor matches exactly, by prefix-equivalence, never by substring', () => {
  P.setProviders([
    { id: 'tr', name: 'tokenrouter', baseURL: '', apiKey: '', models: P.parseDeclaredModels('openai:gpt-5 = 400k\ngpt-4o = 128k') }
  ]);
  assert.equal(P.declaredContextFor('tr', 'openai:gpt-5'), 400000, 'exact');
  assert.equal(P.declaredContextFor('tr', 'gpt-5'), 400000, 'bare alias via prefix equivalence');
  assert.equal(P.declaredContextFor('tr', 'openai/gpt-4o'), 128000, 'slash-prefixed alias');
  assert.equal(P.declaredContextFor('tr', 'gpt-4o-mini'), 0, 'near-miss id must not borrow');
  assert.equal(P.declaredContextFor('other', 'gpt-4o'), 0, 'declarations are per-provider');
  P.setProviders([]);
});

test('normalizeDeclaredModels drops junk and duplicate ids', () => {
  const n = P.normalizeDeclaredModels([
    { id: 'a-1', context: 8192 },
    { id: 'A-1', context: 9999 }, // duplicate (case-insensitive) — first wins
    { id: '', context: 8192 },
    { id: 'b-1', context: 100 }, // below the 1024 floor
    null
  ]);
  assert.deepEqual(n, [{ id: 'a-1', context: 8192 }]);
});
