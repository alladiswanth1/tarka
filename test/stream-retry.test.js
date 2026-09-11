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
    'HTTP 404 Not Found',
    'HTTP 422 Unprocessable Entity',
    'invalid api key',
    'model not found',
    // A 4xx status is a refusal even when the body uses transient language.
    'Upstream HTTP 400: model temporarily unavailable',
    'Upstream HTTP 403 service unavailable',
    'Upstream HTTP 404 timeout looking up that model'
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
  assert.equal(
    R.shouldRetryStream({
      attempt: 1,
      streamedAnswer: '',
      error: 'Upstream HTTP 400: model temporarily unavailable'
    }),
    false,
    '4xx refusals are not retried even with transient wording'
  );
  assert.equal(
    R.shouldRetryStream({ attempt: 1, streamedAnswer: '', error: 'HTTP 429 Too Many Requests' }),
    true,
    '429 remains the retryable 4xx'
  );
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

  const blank = R.soloAssistantDisposition({ fullContent: '  \n\t  ', reasoningContent: '' });
  assert.equal(blank.persist, false, 'whitespace-only is an empty reply');
  assert.equal(blank.display, 'empty');

  const blankThink = R.soloAssistantDisposition({
    fullContent: '\n  ',
    reasoningContent: 'chain of thought…'
  });
  assert.equal(blankThink.persist, false);
  assert.equal(blankThink.display, 'reasoning-only');
});

/*
 * The status travels as DATA. Parsed out of prose, OpenAI's real 429 body
 * ("Please try again in 425ms") read as a 425 refusal and was never retried.
 */
test('a 429 whose body mentions a duration is still transient', () => {
  const msg = 'Upstream HTTP 429: Rate limit reached for gpt-4o. Please try again in 425ms.';
  assert.equal(R.isTransientProviderError(msg), true, 'prose: 425ms is a duration, not a status');
  assert.equal(R.isTransientProviderError(Object.assign(new Error(msg), { status: 429 })), true);
  assert.equal(R.isTransientProviderError(Object.assign(new Error('temporarily unavailable'), { status: 400 })), false, 'status wins over prose');
  assert.equal(R.isTransientProviderError(Object.assign(new Error('nope'), { status: 503 })), true);
  assert.equal(R.isTransientProviderError('HTTP 401 Unauthorized'), false);
  assert.equal(R.isTransientProviderError('error code 400.'), false, 'a trailing period still ends the code');
  assert.equal(R.errorStatus({ status: '429' }), 429);
  assert.equal(R.errorStatus({ status: 0 }), null);
});
