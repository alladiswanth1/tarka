/**
 * Shared completion precision: which provider errors are worth one automatic
 * retry, and whether a Solo reply should be persisted.
 *
 * Pure: no DOM, no fetch. Solo, Debate, and Project all share the classifier
 * so a 402-class refusal cannot be treated as a blip on one path and a retry
 * on another. Tests import this module directly.
 */

/** Errors worth one automatic retry (rate limits, 5xx, network blips) */
const TRANSIENT_ERROR_RE =
  /(^|\D)(429|500|502|503|504|529)(\D|$)|rate.?limit|too many requests|timeout|timed out|overloaded|temporar|unavailable|econn|socket|network|fetch failed|bad gateway/i;

/** 402 / payment / credit refusals are permanent for this request. */
const PAYMENT_REFUSAL_RE =
  /(^|\D)402(\D|$)|payment required|insufficient (funds|credits)|credit.?balance/i;

function errorMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.error || err);
}

function isTransientProviderError(err) {
  const msg = errorMessage(err);
  if (!msg) return false;
  // A 402-class refusal is not a blip, even if the body also says "unavailable".
  if (PAYMENT_REFUSAL_RE.test(msg)) return false;
  return TRANSIENT_ERROR_RE.test(msg);
}

/**
 * At most one automatic retry, and only when no answer text has arrived.
 * Retrying after tokens have streamed would duplicate them in the transcript.
 */
function shouldRetryStream({
  attempt = 1,
  maxAttempts = 2,
  streamedAnswer = '',
  error = '',
  cancelled = false,
  stale = false,
  aborted = false
} = {}) {
  if (aborted || cancelled || stale) return false;
  if (attempt >= maxAttempts) return false;
  if (String(streamedAnswer || '').length > 0) return false;
  if (!error) return false;
  return isTransientProviderError(error);
}

/**
 * What to show and whether to persist after a Solo completion.
 * Empty / reasoning-only replies must not write an empty assistant turn —
 * some providers reject that on the next request.
 */
function soloAssistantDisposition({ fullContent, reasoningContent } = {}) {
  const text = String(fullContent || '');
  if (text) {
    return { persist: true, display: 'content', content: text };
  }
  if (reasoningContent) {
    return {
      persist: false,
      display: 'reasoning-only',
      content: '(model returned reasoning only — try a different model or lower reasoning effort)'
    };
  }
  return {
    persist: false,
    display: 'empty',
    content: '(empty response — check model name, base URL, and API key)'
  };
}

export {
  TRANSIENT_ERROR_RE,
  PAYMENT_REFUSAL_RE,
  isTransientProviderError,
  shouldRetryStream,
  soloAssistantDisposition
};
