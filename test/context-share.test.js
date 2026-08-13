'use strict';
/**
 * contextStore.js — cross-provider window borrowing. A gateway that lists no
 * context fields (TokenRouter et al.) must be able to reuse the window another
 * configured provider reported for the same model.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

// contextStore imports state.js, which touches DOM globals at module scope.
const storageStub = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
};
globalThis.document = { querySelector: () => null };
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = storageStub();

let S;
test.before(async () => {
  S = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'contextStore.js')).href);
});

test('a window reported by another provider is borrowed for the same model', () => {
  S.putCachedContext('openrouter', 'openai/gpt-4o', 128000);
  const hit = S.getSharedContext('openai:gpt-4o', 'tokenrouter');
  assert.ok(hit, 'prefix-equivalent id must resolve across providers');
  assert.equal(hit.limit, 128000);
  assert.equal(hit.providerId, 'openrouter');
});

test('an exact id match outranks a prefix-equivalent one', () => {
  S.putCachedContext('openrouter', 'moonshotai/kimi-k3', 131072);
  S.putCachedContext('other', 'kimi-k3', 200000);
  const hit = S.getSharedContext('kimi-k3', 'tokenrouter');
  assert.equal(hit.limit, 200000, 'the exact id wins over the prefixed one');
  assert.equal(hit.providerId, 'other');
});

test('the asking provider itself is excluded', () => {
  S.putCachedContext('lonely', 'special-model-x1', 42000);
  assert.equal(S.getSharedContext('special-model-x1', 'lonely'), null);
});

test('near-miss ids never borrow a window', () => {
  S.putCachedContext('openrouter', 'openai/gpt-4o-mini', 128000);
  assert.equal(S.getSharedContext('gpt-4o-turbo-preview', 'tokenrouter'), null);
});

test('stale entries are not borrowed', () => {
  // putCachedContext spreads `extra` last, so it can backdate the entry
  S.putCachedContext('openrouter', 'old-model-z9', 64000, {
    at: Date.now() - S.CONTEXT_CACHE_TTL_MS - 1
  });
  assert.equal(S.getSharedContext('old-model-z9', 'tokenrouter'), null);
});
