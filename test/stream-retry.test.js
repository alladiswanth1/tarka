'use strict';
/**
 * Solo / shared stream precision: the shipped transient-error classifier and
 * the retry-only-when-empty policy. Imports the same module Solo and Project
 * call — not a copy, not an oracle.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (rel) =>
  import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', rel)).href);

let R;
test.before(async () => {
  R = await load('net/retry.js');
});

test('the shipped classifier retries 429 / 5xx / timeout / network, not a 402-class refusal', () => {
  const yes = [
    'HTTP 429',
    '429 Too Many Requests',
    'rate limit exceeded',
    'too many requests',
    'HTTP 500 Internal Server Error',
    'HTTP 502',
    'HTTP 503',
    'HTTP 504 Gateway Timeout',
    '529 overloaded',
    'the server is overloaded',
    'timeout waiting for upstream',
    'request timed out',
    'temporarily unavailable',
    'ECONNRESET',
    'socket hang up',
    'network error',
    'fetch failed',
    'Bad Gateway'
  ];
  for (const msg of yes) {
    assert.equal(R.isTransientProviderError(msg), true, msg);
    assert.equal(R.isTransientProviderError(new Error(msg)), true, `Error: ${msg}`);
  }

  const no = [
    'HTTP 402',
    'HTTP 402 Payment Required',
    '402 insufficient credits',
    'Payment Required — add billing',
    'insufficient funds',
    'insufficient credits on this key',
    'credit balance is zero',
    'HTTP 400 Bad Request',
    'HTTP 401 Unauthorized',
    'HTTP 403 Forbidden',
    'invalid api key',
    'model not found'
  ];
  for (const msg of no) {
    assert.equal(R.isTransientProviderError(msg), false, msg);
  }
});

test('the shipped retry policy retries only when streamed answer text is still empty', () => {
  const transient = 'HTTP 503 temporarily unavailable';

  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: transient }),
    true
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: 'Hello', error: transient }),
    false,
    'answer text must never be retried (it would duplicate)'
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 2, streamedAnswer: '', error: transient }),
    false,
    'at most one automatic retry'
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: 'HTTP 402 Payment Required' }),
    false
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: transient, cancelled: true }),
    false
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: transient, aborted: true }),
    false
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: transient, stale: true }),
    false
  );
  assert.equal(R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: '' }), false);
});

test('empty and reasoning-only Solo replies do not persist assistant content', () => {
  const empty = R.soloAssistantDisposition({ fullContent: '', reasoningContent: '' });
  assert.equal(empty.persist, false);
  assert.equal(empty.display, 'empty');
  assert.match(empty.content, /empty response/);

  const reasoning = R.soloAssistantDisposition({
    fullContent: '',
    reasoningContent: 'chain of thought…'
  });
  assert.equal(reasoning.persist, false);
  assert.equal(reasoning.display, 'reasoning-only');
  assert.match(reasoning.content, /reasoning only/);

  const ok = R.soloAssistantDisposition({ fullContent: 'Here is the answer.', reasoningContent: 'think' });
  assert.equal(ok.persist, true);
  assert.equal(ok.display, 'content');
  assert.equal(ok.content, 'Here is the answer.');
});
