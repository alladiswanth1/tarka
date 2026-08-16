'use strict';
/** src/tokens.js — the local context-window table and the rough tokenizer. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let T;
test.before(async () => {
  T = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'tokens.js')).href);
});

test('formatTokenCount', () => {
  assert.equal(T.formatTokenCount(0), '0');
  assert.equal(T.formatTokenCount(999), '999');
  assert.equal(T.formatTokenCount(1500), '1.5k');
  assert.equal(T.formatTokenCount(2000), '2k');
  assert.equal(T.formatTokenCount(128000), '128k');
  assert.equal(T.formatTokenCount(1_000_000), '1M');
  assert.equal(T.formatTokenCount(1_048_576), '1M');
  assert.equal(T.formatTokenCount(null), '—');
  assert.equal(T.formatTokenCount(NaN), '—');
});

test('estimateTokens: latin ~4 chars/token, CJK ~1', () => {
  assert.equal(T.estimateTokens(''), 0);
  assert.equal(T.estimateTokens(null), 0);
  const latin = T.estimateTokens('a'.repeat(400));
  assert.ok(latin >= 100 && latin <= 105, latin);
  const cjk = T.estimateTokens('漢'.repeat(100));
  assert.ok(cjk >= 100 && cjk <= 105, cjk);
  // Denser scripts must not be under-counted relative to latin
  assert.ok(T.estimateTokens('日本語テキスト') > T.estimateTokens('abcdefg'));
});

/*
 * Regression: the family table was consulted first, so an id that states its
 * own window ("...-32k") was overruled by its family's default. A model that
 * says 32k and gets budgeted at 128k overruns the provider's hard limit.
 */
test('an explicit size in the id beats the family table', () => {
  assert.deepEqual(T.lookupKnownContext('deepseek-r1-distill-llama-70b-32k'), {
    limit: 32000,
    source: 'name-hint'
  });
  assert.deepEqual(T.lookupKnownContext('qwen-2.5-14b-1m'), { limit: 1_000_000, source: 'name-hint' });
  assert.deepEqual(T.lookupKnownContext('moonshot-v1-8k'), { limit: 8000, source: 'name-hint' });
  assert.deepEqual(T.lookupKnownContext('some-unknown-model-128k'), {
    limit: 128000,
    source: 'name-hint'
  });
  assert.equal(T.lookupKnownContext('model:32k').source, 'name-hint');
  assert.equal(T.lookupKnownContext('vendor/model-16k').source, 'name-hint');
});

test('a version number is not mistaken for a size hint', () => {
  // These must fall through to the family table, not parse "4o"/"3.1"/"4" as k/m
  for (const id of [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'claude-3-5-haiku',
    'llama-3.1-405b', 'mixtral-8x7b', 'phi-4', 'grok-3', 'command-r-plus',
    'deepseek-v3', 'qwen-14b-q4_k_m'
  ]) {
    assert.notEqual(T.lookupKnownContext(id).source, 'name-hint', id);
  }
});

test('the family table still answers well-known ids', () => {
  const expect = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16385,
    'o3-mini': 200000,
    'claude-3-opus': 200000,
    'anthropic/claude-3.5-sonnet': 200000,
    'gemini-2.5-pro': 1048576,
    'deepseek-r1': 128000,
    'moonshotai/kimi-k3': 128000,
    'grok-3': 131072,
    'grok-build': 256000,
    'mistral-large-latest': 128000
  };
  for (const [id, limit] of Object.entries(expect)) {
    const r = T.lookupKnownContext(id);
    assert.equal(r.limit, limit, `${id} -> ${r.limit} (${r.source})`);
    assert.equal(r.source, 'known', id);
  }
});

test('an unknown id falls back to the documented default', () => {
  const r = T.lookupKnownContext('totally-made-up-model');
  assert.equal(r.source, 'default');
  assert.equal(r.limit, T.DEFAULT_CONTEXT);
  assert.equal(T.lookupKnownContext('').source, 'default');
  assert.equal(T.lookupKnownContext(null).source, 'default');
});

test('an absurd size hint is rejected rather than believed', () => {
  // 900m would claim a 900-million-token window
  assert.notEqual(T.lookupKnownContext('bogus-900m').source, 'name-hint');
  // ...and a sub-1k hint is noise, not a window
  assert.notEqual(T.lookupKnownContext('thing-1k').limit, 1);
});

test('CONTEXT_PATTERNS is ordered specific-before-general', () => {
  // A general pattern placed above a specific one silently shadows it.
  const shadowed = [];
  for (let i = 0; i < T.CONTEXT_PATTERNS.length; i++) {
    for (let j = i + 1; j < T.CONTEXT_PATTERNS.length; j++) {
      const [reGeneral] = T.CONTEXT_PATTERNS[i];
      const [reSpecific, limitSpecific] = T.CONTEXT_PATTERNS[j];
      // Build a probe from the later pattern and see if an earlier one eats it
      const probe = reSpecific.source
        .replace(/\[-_\]\?/g, '-')
        .replace(/\[-_\.\]\?/g, '-')
        .replace(/\\b/g, '')
        .replace(/\\\./g, '.')
        .replace(/[$^]/g, '')
        .replace(/\.\*/g, '-x-');
      if (/[\\[\]()|?+*]/.test(probe)) continue; // not a clean literal — skip
      if (reGeneral.test(probe) && T.CONTEXT_PATTERNS[i][1] !== limitSpecific) {
        shadowed.push(`${probe}: matched by ${reGeneral} before ${reSpecific}`);
      }
    }
  }
  assert.deepEqual(shadowed, [], `\n${shadowed.join('\n')}`);
});
