import { getConfig } from '../config.js';
import { getActiveProvider, isLocalProvider, localAgentsSynced, localProfileReady, providers } from '../providers.js';
import { openProviderEditor } from '../ui/providers.js';
import { openSidebar, setSidebarPanel } from '../ui/sidebar.js';
import { appendError } from '../ui/transcript.js';
import {
  TRANSIENT_ERROR_RE,
  isTransientProviderError,
  shouldRetryStream,
  soloAssistantDisposition
} from './retry.js';

// ========== Send / Stream ==========
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getValidatedConfig() {
  const cfg = getConfig();
  if (!providers.length) {
    appendError('Add a provider (Base URL + API key) in the sidebar first.');
    openSidebar();
    setSidebarPanel('api');
    openProviderEditor(null);
    return null;
  }
  const provider = getActiveProvider();
  if (!cfg.model) {
    appendError('Set a model id in the sidebar first.');
    openSidebar();
    setSidebarPanel('api');
    return null;
  }
  if (isLocalProvider(provider)) {
    if (!localProfileReady(provider)) {
      // Profiles load "not ready" until /api/agents/local has answered, which
      // spawns each CLI for --version. Enter on a restored draft beat that.
      appendError(
        localAgentsSynced
          ? `${provider.name || 'Local agent'} is not signed in on this machine — install the CLI and run its login.`
          : `Still checking whether ${provider.name || 'the local agent'} is signed in — try again in a moment.`
      );
      openSidebar();
      setSidebarPanel('api');
      return null;
    }
    return cfg;
  }
  if (!cfg.apiKey) {
    appendError('Please set your API Key in the sidebar first.');
    openSidebar();
    setSidebarPanel('api');
    return null;
  }
  // Basic base URL sanity check
  try {
    // eslint-disable-next-line no-new
    new URL(cfg.baseURL);
  } catch {
    appendError('Base URL is invalid. Example: https://api.openai.com/v1');
    openSidebar();
    setSidebarPanel('api');
    return null;
  }
  return cfg;
}

/** Turn a stream result's in-band error into an Error that keeps the HTTP status. */
function streamResultError(result) {
  const e = new Error(result?.error || 'Upstream error');
  if (Number.isInteger(result?.status)) e.status = result.status;
  return e;
}

/**
 * Core streaming call: fetch + SSE parsing ONLY (parser moved verbatim from
 * streamAssistantReply). Resolves { content, error, status, cancelled }:
 * - `content`  — accumulated answer text (also fed to onToken chunk-by-chunk)
 * - `error`    — in-stream provider error string (caller decides to throw)
 * - `cancelled`— true if shouldCancel() tripped mid-stream (reader cancelled)
 * Throws on HTTP-level failures and on abort (AbortError), like before.
 */
async function streamCompletion({
  baseURL,
  apiKey,
  model,
  reasoningEffort,
  temperature,
  max_tokens,
  systemPrompt,
  agent,
  messages: msgList,
  signal,
  shouldCancel,
  onToken,
  onReasoningToken,
  onUsage
}) {
  const body = {
    messages: msgList,
    baseURL,
    apiKey,
    model,
    reasoningEffort,
    temperature,
    max_tokens,
    systemPrompt
  };
  const fromField = String(agent || '').trim().toLowerCase();
  if (fromField === 'claude' || fromField === 'codex' || fromField === 'grok') {
    body.agent = fromField;
  } else {
    const a = String(baseURL || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase();
    const m = /^tarka-local:\/\/([a-z0-9-]+)$/.exec(a);
    if (m && (m[1] === 'claude' || m[1] === 'codex' || m[1] === 'grok')) body.agent = m[1];
  }

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (shouldCancel && shouldCancel()) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { content: '', error: null, cancelled: true };
  }

  // Non-SSE error responses (validation etc.)
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (contentType.includes('application/json')) {
      const err = await res.json().catch(() => ({}));
      msg = err.error || msg;
    } else {
      const t = await res.text().catch(() => '');
      if (t) msg = t.slice(0, 300);
    }
    const e = new Error(msg);
    e.status = res.status; // the retry classifier reads this, not the prose
    throw e;
  }

  if (!res.body) {
    throw new Error('No response body (streaming not supported by this browser)');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let streamError = null;
  /** Upstream HTTP status the proxy attached to an in-stream error, if any. */
  let streamStatus = null;
  /** A non-"stop" finish_reason the proxy forwarded on `done` (length, content_filter…). */
  let finishReason = null;

  const handleEvent = (evt) => {
    if (evt.type === 'content' && evt.content) {
      content += evt.content;
      if (onToken) onToken(evt.content, content);
    } else if (evt.type === 'reasoning' && evt.content) {
      const piece = typeof evt.content === 'string' ? evt.content : JSON.stringify(evt.content);
      if (onReasoningToken) onReasoningToken(piece);
    } else if (evt.type === 'done') {
      if (evt.usage && onUsage) onUsage(evt.usage);
      if (typeof evt.finish_reason === 'string') finishReason = evt.finish_reason;
    } else if (evt.type === 'error') {
      streamError = evt.error || 'Upstream error';
      streamStatus = Number.isInteger(evt.status) ? evt.status : null;
    }
  };

  while (true) {
    if (shouldCancel && shouldCancel()) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return { content, error: streamError, status: streamStatus, cancelled: true, finishReason };
    }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // Normalize CRLF → LF so SSE splits work across providers
    buffer = buffer.replace(/\r\n/g, '\n');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          // incomplete / non-JSON keep-alive — ignore
          continue;
        }
        handleEvent(evt);
      }
    }
  }

  // Flush any trailing buffered event
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          handleEvent(JSON.parse(data));
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { content, error: streamError, status: streamStatus, cancelled: false, finishReason };
}

export {
  TRANSIENT_ERROR_RE,
  getValidatedConfig,
  isTransientProviderError,
  shouldRetryStream,
  sleep,
  soloAssistantDisposition,
  streamCompletion,
  streamResultError
};
