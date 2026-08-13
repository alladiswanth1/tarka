'use strict';
/**
 * The streaming chat proxy and the model catalog lookup.
 *
 * handleChat owns the provider-compatibility ladder: a rejected reasoning
 * shape, `max_tokens` vs `max_completion_tokens`, or an unsupported
 * `temperature` each cost exactly one transparent retry rather than killing
 * the request. See reasoningVariants() for the shapes and their order.
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');
const { UPSTREAM_TIMEOUT_MS, MODELS_TIMEOUT_MS, SSE_KEEPALIVE_MS, ATTRIBUTION_HEADERS } = require('./config');
const { parseBody, writeSse } = require('./http');
const { assertProxyTargetAllowed, applyPinnedLookup, isLoopbackRemote } = require('./security');
const { parseLocalAgentRequest, streamLocalAgentChat, localAgentModels } = require('./local-agents');

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          // OpenRouter reasoning_details entries: reasoning.summary carries
          // `summary`, reasoning.encrypted carries opaque `data`. Read the
          // former, drop the latter — base64 in the thought panel is noise.
          if (typeof part.summary === 'string') return part.summary;
          if (typeof part.thinking === 'string') return part.thinking;
        }
        return '';
      })
      .join('');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.summary === 'string') return value.summary;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function normalizeBaseUrl(baseURL) {
  let base = String(baseURL || '').trim().replace(/\/+$/, '');
  // If user pasted the full completions URL, strip it back to the API root
  if (base.endsWith('/chat/completions')) {
    base = base.slice(0, -'/chat/completions'.length);
  }
  return base;
}

/**
 * Build the upstream endpoint URL from a user-supplied Base URL.
 *
 * The endpoint has to be appended to the PATH, not to the string. Azure OpenAI
 * — a documented target, special-cased in reasoningVariants() — is configured
 * as `…/deployments/<name>?api-version=…`, and concatenating produced
 * `?api-version=…/chat/completions`: the request went to the deployment root
 * with a mangled api-version, drawing a 404 that the "missing /v1" hint then
 * misdiagnosed. A fragment was worse — everything after `#` is client-side, so
 * `…/v1#x` dropped the endpoint entirely.
 */
function apiUrl(baseURL, endpoint) {
  const u = new URL(String(baseURL || '').trim()); // throws → caller answers 400
  u.hash = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/chat/completions')) p = p.slice(0, -'/chat/completions'.length);
  u.pathname = p + endpoint;
  return u;
}

/**
 * `URL.hostname` keeps the brackets on an IPv6 literal, and `http.request`
 * does not strip them — `net.isIP('[::1]')` is 0, so it goes to DNS and every
 * request to a local IPv6 Ollama/vLLM dies with ENOTFOUND. Non-loopback
 * clients never hit this because applyPinnedLookup replaces the lookup wholesale.
 */
function requestHostname(targetUrl) {
  return String(targetUrl.hostname || '').replace(/^\[|\]$/g, '');
}

/**
 * An API key becomes an `Authorization` header, and Node throws
 * ERR_INVALID_CHAR synchronously from http.request for anything outside
 * printable Latin-1. A key pasted with a trailing newline is the common case,
 * and that throw used to escape the async handler and kill the process — so
 * this is checked before the request is built, not after.
 * Returns the trimmed key, or null when it cannot be sent as a header.
 */
function headerSafeApiKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key) return null;
  // http.request accepts \t and \x20-\xFF minus \x7F in header values
  if (!/^[\t\x20-\x7E\xA0-\xFF]+$/.test(key)) return null;
  return key;
}

function clampTemperature(value) {
  // null/"" mean "unset", not zero — Number(null) is 0, which would silently
  // turn an omitted temperature into greedy decoding. An explicit 0 still wins.
  if (value == null || value === '') return 0.7;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(2, Math.max(0, n));
}

function clampMaxTokens(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  if (i < 1) return undefined;
  // Soft upper bound to avoid absurd values
  return Math.min(i, 2_000_000);
}

/**
 * Reasoning-effort request shapes, most-likely-first for the target host.
 * OpenRouter-style gateways expect `reasoning: { effort }`; OpenAI and Azure
 * OpenAI reject unknown params with 400 and expect `reasoning_effort` instead.
 * On a 400/422 that looks like a parameter rejection the caller retries the
 * next shape, ending with no reasoning field at all — so one incompatible
 * parameter never kills the chat.
 */
function reasoningVariants(effort, hostname) {
  if (!effort || effort === 'none') return [{ style: null, apply() {} }];
  const h = String(hostname || '').toLowerCase();
  const openaiNative =
    /(^|\.)openai\.com$/.test(h) ||
    /(^|\.)openai\.azure\.com$/.test(h) ||
    /(^|\.)cognitiveservices\.azure\.com$/.test(h);
  const router = {
    style: 'router',
    apply(b) {
      b.reasoning = { effort };
    }
  };
  const native = {
    style: 'native',
    apply(b) {
      // OpenAI accepts low/medium/high (and minimal on some models) — no "max"
      b.reasoning_effort = effort === 'max' ? 'high' : effort;
    }
  };
  const bare = { style: null, apply() {} };
  return openaiNative ? [native, router, bare] : [router, native, bare];
}

/**
 * Split a model id into { base, tag }, stripping any provider prefix.
 *
 * Two prefix conventions are in the wild and they collide on the same
 * character:
 *   OpenRouter   "moonshotai/kimi-k3"   provider before "/"; ":free" is a TAG
 *   TokenRouter  "openai:gpt-4o"        provider before ":"  (per its
 *                                       OpenAI-compatibility docs)
 * So a ":" is only unambiguous by looking at which side is model-shaped —
 * a model id carries a digit or a hyphen ("gpt-4o", "deepseek-r1"), whereas
 * both provider names ("openai", "anthropic") and OpenRouter tags ("free",
 * "nitro", "online") are bare words. When only the right side is model-shaped
 * the ":" is a provider prefix; when only the left side is, it is a tag.
 * Anything else (both, or neither — e.g. TokenRouter's "auto:balance" routing
 * modes) is left intact so unrelated ids never collapse together.
 */
/**
 * Ollama-style variant tags: parameter counts ("7b", "1.5b", "70b"),
 * quantizations ("q4_0", "fp16", "int8") and the stock rollout names. These are
 * the only right-hand sides that are model-shaped yet are NOT the model.
 */
const MODEL_SIZE_TAG_RE =
  /^(?:\d+(?:\.\d+)?[bkm]|q\d+[a-z0-9_-]*|k_[a-z0-9_]+|fp\d+|bf\d+|int\d+|latest)$/;
function splitModelId(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return { base: '', tag: '' };
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  const modelish = (v) => /[0-9]/.test(v) || v.includes('-') || v.includes('.');
  const c = s.indexOf(':');
  if (c > 0 && c < s.length - 1) {
    const left = s.slice(0, c);
    const right = s.slice(c + 1);
    // Ollama's ":7b" / ":q4_0" are VARIANT tags, and they are model-shaped
    // (they carry a digit), so the provider-prefix rule below would read them
    // as the model and throw the name away — collapsing "codellama:7b" and
    // "mistral:7b" to the same base "7b". Size and quantization tags are
    // checked first because only they are ambiguous in this way.
    if (MODEL_SIZE_TAG_RE.test(right)) return { base: left, tag: right };
    if (!modelish(left) && modelish(right)) return { base: right, tag: '' }; // provider prefix
    if (modelish(left) && !modelish(right)) return { base: left, tag: right }; // ":tag" variant
  }
  return { base: s, tag: '' };
}

/**
 * Segment-aware model-id equivalence: exact id, same id under a different
 * provider prefix ("kimi-k3" ↔ "moonshotai/kimi-k3" ↔ "openai:gpt-4o"), or a
 * ":tag" variant of the same base when exactly one side is tagged
 * ("deepseek-r1" ↔ "deepseek-r1:free"). Never matches mere substrings, so
 * "gpt-4o" does NOT match "gpt-4o-mini".
 */
function modelIdsRelated(a, b) {
  const na = String(a || '').trim().toLowerCase();
  const nb = String(b || '').trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = splitModelId(na);
  const pb = splitModelId(nb);
  if (!pa.base || !pb.base) return false;
  if (pa.base !== pb.base) return false;
  // Same base: identical tags match, and an untagged id matches any single
  // tagged variant. Two DIFFERENT tags are different products (":free" is not
  // ":nitro"), so they must not collapse.
  return pa.tag === pb.tag || !pa.tag || !pb.tag;
}

// Proxy streaming chat completions
async function handleChat(req, res) {
  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    const code = e.statusCode || 400;
    // Destroying the socket while the client is still uploading sends an RST
    // that discards the reply we just wrote, so an oversized body surfaced as a
    // generic "Failed to fetch" instead of the actionable size message —
    // exactly what parseBody pauses the stream to make deliverable. Ask for the
    // connection to close, and tear it down only once the 413 has flushed.
    res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: e.message }), () => {
      if (e.statusCode === 413) {
        try {
          req.destroy();
        } catch (_) {
          /* ignore */
        }
      }
    });
    return;
  }

  // `null` is valid JSON, so parseBody can hand back a non-object body
  if (!payload || typeof payload !== 'object') payload = {};

  const {
    messages = [],
    baseURL = 'https://api.tokenrouter.com/v1',
    reasoningEffort = 'none',
    temperature = 0.7,
    max_tokens,
    systemPrompt
  } = payload;
  const model = String(payload.model == null || payload.model === '' ? 'moonshotai/kimi-k3' : payload.model);

  const localAgent = parseLocalAgentRequest(payload);
  if (localAgent) {
    if (!isLoopbackRemote(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local Claude / Codex agents are available from this machine only' }));
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Messages array is required' }));
      return;
    }
    const finalMessages = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const role = m && typeof m.role === 'string' ? m.role.trim() : '';
      const content = m ? m.content : null;
      if (!role || !(typeof content === 'string' || Array.isArray(content))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Invalid message at index ${i}: role must be a string, content a string or array`
          })
        );
        return;
      }
      finalMessages.push({ role, content });
    }
    streamLocalAgentChat(res, {
      agent: localAgent,
      messages: finalMessages,
      systemPrompt,
      model
    });
    return;
  }

  const apiKey = headerSafeApiKey(payload.apiKey);
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: payload.apiKey
          ? 'API key contains characters that cannot be sent in a header — check for a stray newline or non-ASCII character.'
          : 'API key is required'
      })
    );
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Messages array is required' }));
    return;
  }

  let targetUrl;
  let addressPin = null;
  try {
    targetUrl = apiUrl(baseURL, '/chat/completions');
    addressPin = await assertProxyTargetAllowed(req, targetUrl);
  } catch (e) {
    const code = e.statusCode || 400;
    const msg = e.statusCode ? e.message : `Invalid base URL: ${e.message}`;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // Build final messages — validate types so malformed input never reaches the wire
  const finalMessages = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m && typeof m.role === 'string' ? m.role.trim() : '';
    const content = m ? m.content : null;
    if (!role || !(typeof content === 'string' || Array.isArray(content))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Invalid message at index ${i}: role must be a string, content a string or array`
        })
      );
      return;
    }
    finalMessages.push({ role, content });
  }
  if (systemPrompt && String(systemPrompt).trim()) {
    const hasSystem = finalMessages.some((m) => m.role === 'system');
    if (!hasSystem) {
      finalMessages.unshift({ role: 'system', content: String(systemPrompt).trim() });
    }
  }

  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const variants = reasoningVariants(reasoningEffort, targetUrl.hostname);

  // SSE headers to client (same-origin only — no wildcard CORS)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // Flush headers early (if supported)
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let cleanedUp = false;
  let upstream = null;
  /** True once any upstream body byte has been forwarded — changes what a stall means. */
  let sawUpstreamData = false;

  // While the upstream is silent (a reasoning model can think for minutes
  // without emitting a byte), keep the downstream connection visibly alive.
  // SSE comment lines are ignored by the client parser; without them a
  // reverse proxy in front of Tarka may kill the "idle" response first.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
  }, SSE_KEEPALIVE_MS);
  keepAlive.unref();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(keepAlive);
    if (upstream && !upstream.destroyed) {
      upstream.destroy();
    }
  };

  // `res`, not `req`. Since Node 16 an IncomingMessage emits 'close' as soon as
  // its body is consumed, and parseBody above already did that — a listener
  // added here would be registered after the event had fired, so it could never
  // run, while looking like a working disconnect handler. `res` closes only on
  // response end or socket death, which is what a disconnect actually is.
  // Same trap as projectExec; see ARCHITECTURE.md.
  res.on('close', cleanup);

  /**
   * One upstream attempt. `state` tracks the compat fallbacks tried so far:
   * - variantIdx        — reasoning-shape ladder (router → native → none)
   * - dropTemperature   — OpenAI o-series rejects non-default temperature
   * - maxTokensField    — o-series wants max_completion_tokens, not max_tokens
   * - dropStreamOptions — a few gateways reject stream_options outright
   * Each rejected parameter triggers exactly one transparent retry with the
   * next shape; a hard cap on attempts prevents ping-pong loops.
   */
  const startAttempt = (state) => {
    const { variantIdx } = state;
    // Build request body for upstream (keep fields conservative for max compatibility)
    // temperature clamped to [0, 2]; max_tokens must be a positive integer
    const upstreamBody = {
      model,
      messages: finalMessages,
      stream: true
    };
    // Without this, OpenAI and every server that copies it (Azure, vLLM,
    // Together, Fireworks, DeepSeek, Groq, Ollama's shim) stream the answer and
    // then simply never report token usage — the context meter would run on
    // character-count estimates forever. OpenRouter sends usage regardless and
    // documents this field as accepted-but-ignored, so it is safe there too.
    // The ladder below drops it for the rare gateway that 400s on it.
    if (!state.dropStreamOptions) upstreamBody.stream_options = { include_usage: true };
    if (!state.dropTemperature) upstreamBody.temperature = clampTemperature(temperature);
    const clampedMax = clampMaxTokens(max_tokens);
    if (clampedMax != null) upstreamBody[state.maxTokensField] = clampedMax;
    variants[variantIdx].apply(upstreamBody);

    const upstreamPayload = JSON.stringify(upstreamBody);
    const options = applyPinnedLookup(
      {
        hostname: requestHostname(targetUrl),
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(upstreamPayload),
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
          // Helpful for OpenRouter-compatible gateways; ignored by others
          ...ATTRIBUTION_HEADERS
        },
        timeout: UPSTREAM_TIMEOUT_MS
      },
      addressPin
    );

    upstream = lib.request(options, (upRes) => {
      const status = upRes.statusCode || 0;

      // Some gateways return JSON errors with 4xx/5xx
      if (status >= 400) {
        const errChunks = [];
        let errBytes = 0;
        let errTooLarge = false;
        upRes.on('data', (c) => {
          if (errTooLarge) return;
          errBytes += c.length;
          // An error body is read only to name the failure, so 8MB is already
          // far past useful. Ending the transfer matters as much as bounding
          // memory: the decision below is made in the 'end' handler, so a host
          // that answers 400 and then streams for an hour would hold the
          // client's response, the upstream socket and the retry ladder open for
          // that whole time — and the idle timeout cannot rescue it, because
          // every byte counts as activity.
          if (errBytes > MAX_CHAT_BUFFER) {
            errTooLarge = true;
            writeSse(res, {
              type: 'error',
              error: `Upstream HTTP ${status}, and its error body exceeded 8MB — aborting.`
            });
            if (!res.writableEnded) res.end();
            upRes.destroy();
            cleanup();
            return;
          }
          errChunks.push(c);
        });
        upRes.on('end', () => {
          if (errTooLarge) return;
          const errBody = Buffer.concat(errChunks).toString('utf8');
          // Parameter-shape rejections → transparently retry with the next
          // compatible shape. Checked most-specific-first so e.g. an OpenAI
          // "Unsupported parameter: 'max_tokens'" doesn't burn reasoning
          // retries before the actual fix is applied.
          const sentReasoning = !!variants[variantIdx].style;
          const paramish = status === 400 || status === 422;
          const generic = /unrecognized|unknown|unexpected|unsupported|invalid|not supported|does not support|extra_forbidden/i.test(
            errBody
          );
          const canRetry = state.attempts < 6 && !cleanedUp && !res.writableEnded;
          if (paramish && canRetry) {
            // 0) stream_options unsupported — checked first because it is the
            // narrowest signal and dropping it costs nothing but usage stats
            // `generic &&` like every rule below it: many gateways echo the
            // offending request back in the error body, and that body always
            // contains "stream_options" — so without this a 400 that is really
            // about `temperature` burned this retry first and the turn ended up
            // permanently reporting no token usage, which is the one thing
            // stream_options exists to provide.
            if (
              generic &&
              /stream_options|include_usage/i.test(errBody) &&
              !state.dropStreamOptions
            ) {
              startAttempt({ ...state, dropStreamOptions: true, attempts: state.attempts + 1 });
              return;
            }
            // 1) max_tokens → max_completion_tokens (OpenAI reasoning models)
            if (
              generic &&
              /max_tokens/i.test(errBody) &&
              state.maxTokensField === 'max_tokens' &&
              clampMaxTokens(max_tokens) != null
            ) {
              startAttempt({ ...state, maxTokensField: 'max_completion_tokens', attempts: state.attempts + 1 });
              return;
            }
            // 2) temperature unsupported (o-series accepts only the default)
            if (generic && /temperature/i.test(errBody) && !state.dropTemperature) {
              startAttempt({ ...state, dropTemperature: true, attempts: state.attempts + 1 });
              return;
            }
            // 3) reasoning field shape (router ↔ native ↔ none)
            if (sentReasoning && (generic || /reasoning/i.test(errBody)) && variantIdx + 1 < variants.length) {
              startAttempt({ ...state, variantIdx: variantIdx + 1, attempts: state.attempts + 1 });
              return;
            }
          }
          let msg = `Upstream HTTP ${status}`;
          try {
            const j = JSON.parse(errBody);
            msg =
              j.error?.message ||
              j.error?.code ||
              (typeof j.error === 'string' ? j.error : null) ||
              j.message ||
              errBody.slice(0, 400);
          } catch (_) {
            if (errBody) msg = errBody.replace(/\s+/g, ' ').trim().slice(0, 400);
          }
          if (status === 404 && !/\/v\d+\//.test(targetUrl.pathname)) {
            msg += ' — hint: the Base URL may be missing “/v1”';
          }
          writeSse(res, { type: 'error', error: msg });
          if (!res.writableEnded) res.end();
          cleanup();
        });
        return;
      }

      // Non-SSE JSON body (rare but happens when provider ignores stream:true)
      const upType = String(upRes.headers['content-type'] || '');
      if (upType.includes('application/json') && !upType.includes('text/event-stream')) {
        const bodyChunks = [];
        let jsonBytes = 0;
        let jsonTooLarge = false;
        upRes.on('data', (c) => {
          if (jsonTooLarge) return;
          jsonBytes += c.length;
          if (jsonBytes > MAX_CHAT_BUFFER) {
            jsonTooLarge = true;
            writeSse(res, {
              type: 'error',
              error: 'Provider returned a non-streaming response larger than 8MB — aborting.'
            });
            if (!res.writableEnded) res.end();
            upRes.destroy();
            cleanup();
            return;
          }
          bodyChunks.push(c);
        });
        upRes.on('end', () => {
          if (jsonTooLarge) return;
          const body = Buffer.concat(bodyChunks).toString('utf8');
          try {
            const j = JSON.parse(body);
            if (j.error) {
              const msg =
                j.error?.message ||
                (typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
              writeSse(res, { type: 'error', error: msg });
            } else {
              const content =
                extractText(j.choices?.[0]?.message?.content) ||
                extractText(j.choices?.[0]?.text) ||
                '';
              if (content) writeSse(res, { type: 'content', content });
              if (j.usage) writeSse(res, { type: 'done', usage: j.usage });
              if (!content && !j.usage) {
                writeSse(res, {
                  type: 'error',
                  error: 'Provider returned JSON without content. Check model id and base URL.'
                });
              }
            }
          } catch (e) {
            writeSse(res, {
              type: 'error',
              error: 'Invalid JSON from provider: ' + e.message
            });
          }
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          cleanup();
        });
        return;
      }

      let buffer = '';
      // Decode UTF-8 safely across TCP chunk boundaries (emoji / CJK / Indic)
      const utf8 = new StringDecoder('utf8');
      // Trailing \r from previous chunk awaiting possible \n (CRLF split across chunks)
      let trailCR = false;
      /*
       * Usage is emitted ONCE, at stream end, holding the last figures seen.
       * Some gateways attach a running `usage` to every chunk instead of only
       * the final one; forwarding each would make the debate arena's running
       * total (which sums what it receives) over-report by a factor of the
       * chunk count. Last-write-wins matches both conventions, because the
       * final chunk always carries the definitive numbers.
       */
      let pendingUsage = null;

      /**
       * SSE framing: an event may span several `data:` lines, which the spec
       * says are joined with newlines and delivered when a blank line arrives.
       * Parsing each line on its own dropped every event from a provider that
       * pretty-prints its JSON — silently, since the parse failure looks exactly
       * like a partial line.
       */
      let dataLines = [];

      /** Translate one complete upstream event into client SSE events. */
      const handleUpstreamEvent = (parsed) => {
        if (parsed.error) {
          const msg =
            parsed.error?.message ||
            (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
          writeSse(res, { type: 'error', error: msg });
          return;
        }

        // OpenAI-style chunk. The usage-bearing chunk carries `choices: []`,
        // so this block is skipped for it and the usage check below still runs.
        if (parsed.choices && parsed.choices[0]) {
          const choice = parsed.choices[0];
          const delta = choice.delta || {};
          const message = choice.message || {};

          // Content (streaming delta or full message)
          const content =
            extractText(delta.content) ||
            extractText(delta.text) ||
            extractText(message.content) ||
            '';
          if (content) {
            writeSse(res, { type: 'content', content });
          }

          // Reasoning fields used by various providers
          const reasoning =
            extractText(delta.reasoning) ||
            extractText(delta.reasoning_content) ||
            extractText(delta.reasoning_details) ||
            extractText(delta.thinking) ||
            extractText(message.reasoning) ||
            extractText(message.reasoning_content) ||
            extractText(message.thinking) ||
            '';
          if (reasoning) {
            writeSse(res, { type: 'reasoning', content: reasoning });
          }
        }

        // Usage: normally only on the final chunk, but some gateways repeat
        // it — keep the newest and emit once at end of stream.
        if (parsed.usage && typeof parsed.usage === 'object') {
          pendingUsage = parsed.usage;
        }
      };

      /** Deliver whatever `data:` lines have accumulated as one event. */
      const flushEvent = () => {
        if (!dataLines.length) return;
        const data = dataLines.join('\n').trim();
        dataLines = [];
        // Defer the final [DONE] to upRes 'end' so we only send one
        if (!data || data === '[DONE]') return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // malformed event
        }
        handleUpstreamEvent(parsed);
      };

      const handleUpstreamLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          flushEvent(); // blank line terminates the event
          return;
        }
        if (trimmed.startsWith(':')) return; // comment / keep-alive
        if (!trimmed.startsWith('data:')) return; // event:, id:, retry: — unused
        dataLines.push(trimmed.slice(5).trim());
        // Providers overwhelmingly send one complete JSON value per data line,
        // and plenty omit the blank separator — so deliver as soon as what we
        // hold is complete. A pretty-printed object simply does not parse until
        // its last line arrives, which is exactly the framing we want.
        const joined = dataLines.join('\n').trim();
        if (joined === '[DONE]') {
          dataLines = [];
          return;
        }
        try {
          JSON.parse(joined);
        } catch {
          return; // incomplete — wait for the rest of the event
        }
        flushEvent();
      };

      upRes.on('data', (chunk) => {
        sawUpstreamData = true;
        let s = utf8.write(chunk);
        // `buffer` only ever shrinks when a complete line arrives, so an
        // upstream that never emits a newline grows it without bound — and
        // because every byte counts as activity, the idle timeout never fires
        // either. A single SSE line this long is malformed by any reading.
        if (buffer.length > MAX_CHAT_BUFFER) {
          writeSse(res, {
            type: 'error',
            error: 'Provider sent an oversized SSE line (>8MB without a line break) — aborting.'
          });
          if (!res.writableEnded) res.end();
          upRes.destroy();
          cleanup();
          return;
        }
        // Resolve CRLF split across chunk boundaries without re-scanning whole buffer
        if (trailCR) {
          if (s.startsWith('\n')) {
            buffer += '\n';
            s = s.slice(1);
          } else {
            buffer += '\n'; // bare CR was a line break
          }
          trailCR = false;
        }
        if (s.endsWith('\r')) {
          trailCR = true;
          s = s.slice(0, -1);
        }
        // Normalize only this chunk
        s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        buffer += s;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) handleUpstreamLine(line);
      });

      upRes.on('end', () => {
        // Flush any partial multi-byte UTF-8 sequence held by the decoder
        const tail = utf8.end();
        if (tail) buffer += tail;
        if (trailCR) {
          buffer += '\n';
          trailCR = false;
        }
        // A provider that ends the body without a trailing newline leaves its
        // LAST event sitting in `buffer` — and with stream_options that event
        // is the usage chunk. Parse the remainder before finishing.
        if (buffer) {
          for (const line of buffer.split('\n')) handleUpstreamLine(line);
          buffer = '';
        }
        // A body that ends without its final blank line leaves the last event
        // held in dataLines — and with stream_options that event is the usage.
        flushEvent();
        if (pendingUsage) {
          writeSse(res, { type: 'done', usage: pendingUsage });
          pendingUsage = null;
        }
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        cleanup();
      });

      upRes.on('error', (err) => {
        writeSse(res, { type: 'error', error: err.message });
        if (!res.writableEnded) res.end();
        cleanup();
      });
    });

    // Idle timeout: no bytes on the upstream socket for UPSTREAM_TIMEOUT_MS.
    // Say which phase died — "never answered" and "stalled mid-stream" have
    // different fixes — and name the env var that raises the limit.
    upstream.on('timeout', () => {
      const secs = Math.round(UPSTREAM_TIMEOUT_MS / 1000);
      writeSse(res, {
        type: 'error',
        error: sawUpstreamData
          ? `Upstream stalled mid-response (no data for ${secs}s). Set UPSTREAM_TIMEOUT_MS higher if this provider has long silent gaps.`
          : `Upstream sent nothing for ${secs}s. Slow reasoning models can sit silent this long — set UPSTREAM_TIMEOUT_MS higher to wait longer.`
      });
      if (!res.writableEnded) res.end();
      cleanup();
    });

    upstream.on('error', (err) => {
      writeSse(res, {
        type: 'error',
        error: err.message || 'Failed to reach upstream API'
      });
      if (!res.writableEnded) res.end();
      cleanup();
    });

    upstream.write(upstreamPayload);
    upstream.end();
  };

  startAttempt({
    variantIdx: 0,
    dropTemperature: false,
    dropStreamOptions: false,
    maxTokensField: 'max_tokens',
    attempts: 0
  });
}

/**
 * Ceiling on anything handleChat buffers whole from an upstream: an error body,
 * a non-SSE JSON reply, and the SSE line buffer itself. `handleModels` has
 * always capped its body; the chat path did not, so a provider (or anything
 * impersonating one via a user-supplied Base URL) answering with a multi-GB
 * error page — or streaming bytes that never contain a newline, which also
 * keeps the idle timeout from ever firing — grew the buffer until the process
 * died, taking every other in-flight chat with it.
 */
const MAX_CHAT_BUFFER = 8 * 1024 * 1024;

/** Hard ceiling on a decompressed /models body — a gzip bomb must not OOM us. */
const MAX_DECODED_BODY = 32 * 1024 * 1024;

/** Most models returned to the client. Aggregators legitimately list >1000. */
const MODEL_LIST_CAP = 4000;

/**
 * Decode a response body honouring Content-Encoding. Node's http client never
 * decompresses, so this is only reached because we asked for gzip above.
 * `maxOutputLength` bounds the inflated size: without it, a compression bomb
 * behind an otherwise-valid 8MB response could exhaust memory.
 */
function decodeBody(buf, contentEncoding) {
  const enc = String(contentEncoding || '').trim().toLowerCase();
  const opts = { maxOutputLength: MAX_DECODED_BODY };
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, opts).toString('utf8');
  if (enc === 'deflate') return zlib.inflateSync(buf, opts).toString('utf8');
  if (enc === 'br') return zlib.brotliDecompressSync(buf, opts).toString('utf8');
  return buf.toString('utf8');
}

/** Fields that unambiguously mean "completion cap", never "context window". */
function hasCompletionCapField(model) {
  return [
    model.max_completion_tokens,
    model.max_output_tokens,
    model.max_response_tokens,
    model?.top_provider?.max_completion_tokens,
    model?.limits?.max_completion_tokens,
    model?.limits?.max_output_tokens
  ].some((v) => Number.isFinite(Number(v)) && Number(v) > 0);
}

/**
 * Smallest `max_tokens` we will believe is a context window when nothing
 * disambiguates it. Completion caps cluster at 4096/8192/16384; a context
 * window that small is rare enough that guessing "completion cap" and falling
 * back to the local table is the safer error. Guessing wrong the other way
 * pins the meter at ~4k, fires "context nearly full" on the first message, and
 * shreds every debate/project prompt down to the trim floor.
 */
const AMBIGUOUS_MAX_TOKENS_FLOOR = 32_768;

function pickContextLength(model) {
  if (!model || typeof model !== 'object') return null;
  // Unambiguous context fields first — `max_tokens` is handled separately
  // below because most providers use it for the completion cap.
  const candidates = [
    model.context_length,
    model.context_window,
    model.max_context_length,
    model.max_model_len,
    model.max_input_tokens,
    model.n_ctx,
    model.context_size,
    model.contextLength,
    model?.top_provider?.context_length,
    model?.architecture?.context_length,
    model?.limits?.max_context_tokens,
    model?.limits?.context_window
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  // No explicit context field. `max_tokens` is only trustworthy here when the
  // model object ALSO reports a separate completion cap (so max_tokens cannot
  // be that), or when it is too large to plausibly be one.
  const fallbacks = [model.max_tokens, model?.meta?.max_tokens];
  const disambiguated = hasCompletionCapField(model);
  for (const c of fallbacks) {
    const n = Number(c);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (disambiguated || n >= AMBIGUOUS_MAX_TOKENS_FLOOR) return Math.round(n);
  }
  return null;
}

// Proxy POST /api/models → upstream GET /v1/models — extract context limits when exposed
async function handleModels(req, res) {
  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    const code = e.statusCode || 400;
    // Destroying the socket while the client is still uploading sends an RST
    // that discards the reply we just wrote, so an oversized body surfaced as a
    // generic "Failed to fetch" instead of the actionable size message —
    // exactly what parseBody pauses the stream to make deliverable. Ask for the
    // connection to close, and tear it down only once the 413 has flushed.
    res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: e.message }), () => {
      if (e.statusCode === 413) {
        try {
          req.destroy();
        } catch (_) {
          /* ignore */
        }
      }
    });
    return;
  }

  if (!payload || typeof payload !== 'object') payload = {};

  const { baseURL = '', model = '' } = payload;
  const localAgent = parseLocalAgentRequest(payload);
  if (localAgent) {
    if (!isLoopbackRemote(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'Local Claude / Codex agents are available from this machine only',
          models: [],
          context: null
        })
      );
      return;
    }
    const models = localAgentModels(localAgent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, models, count: models.length, context: null }));
    return;
  }

  const apiKey = headerSafeApiKey(payload.apiKey);
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: payload.apiKey
          ? 'API key contains characters that cannot be sent in a header — check for a stray newline or non-ASCII character.'
          : 'API key is required',
        models: [],
        context: null
      })
    );
    return;
  }

  let targetUrl;
  let addressPin = null;
  try {
    targetUrl = apiUrl(baseURL, '/models');
    addressPin = await assertProxyTargetAllowed(req, targetUrl);
  } catch (e) {
    const code = e.statusCode || 400;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: e.statusCode ? e.message : `Invalid base URL: ${e.message}`,
        models: [],
        context: null
      })
    );
    return;
  }

  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = applyPinnedLookup(
    {
      hostname: requestHostname(targetUrl),
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        // A big gateway catalog is multiple MB of JSON that compresses ~10:1.
        // Node never sets this itself and never decompresses for you, so the
        // gzip branch in the reader below is what makes it safe to ask.
        'Accept-Encoding': 'gzip, deflate',
        ...ATTRIBUTION_HEADERS
      },
      timeout: MODELS_TIMEOUT_MS
    },
    addressPin
  );

  let responded = false;
  const sendJson = (obj) => {
    if (responded || res.writableEnded) return;
    responded = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const upstream = lib.request(options, (upRes) => {
    const bodyChunks = [];
    let bodySize = 0;
    let tooLarge = false;
    upRes.on('data', (c) => {
      if (tooLarge) return;
      bodySize += c.length;
      if (bodySize > 8 * 1024 * 1024) {
        tooLarge = true;
        // Respond before destroy so the browser fetch does not hang
        sendJson({
          ok: false,
          error: 'Provider /models response too large',
          models: [],
          context: null
        });
        upRes.destroy();
        return;
      }
      bodyChunks.push(c);
    });
    upRes.on('end', () => {
      if (tooLarge || responded) return;
      let body;
      try {
        body = decodeBody(Buffer.concat(bodyChunks), upRes.headers['content-encoding']);
      } catch (e) {
        sendJson({
          ok: false,
          error: `Could not decode /models response: ${e.message}`,
          models: [],
          context: null
        });
        return;
      }
      if (upRes.statusCode >= 400) {
        let errMsg = body.slice(0, 300) || `Upstream HTTP ${upRes.statusCode}`;
        if (upRes.statusCode === 404 && !/\/v\d+\//.test(targetUrl.pathname)) {
          errMsg += ' — hint: the Base URL may be missing “/v1”';
        }
        sendJson({
          ok: false,
          status: upRes.statusCode,
          error: errMsg,
          models: [],
          context: null
        });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        sendJson({ ok: false, error: 'Invalid JSON from /models', models: [], context: null });
        return;
      }

      const list = Array.isArray(parsed.data)
        ? parsed.data
        : Array.isArray(parsed.models)
          ? parsed.models
          : Array.isArray(parsed)
            ? parsed
            : [];

      const models = list
        .map((m) => {
          if (!m || typeof m !== 'object') return null;
          const id = m.id || m.name || m.model || '';
          const context = pickContextLength(m);
          return id
            ? {
                id: String(id),
                context,
                owned_by: m.owned_by || m.organization || null
              }
            : null;
        })
        .filter(Boolean);

      let context = null;
      let matchedId = null;
      if (model) {
        const want = String(model).toLowerCase();
        // An exact id that reports NO context is not an answer — keep looking.
        // `exact || find(...)` made a context-less exact entry win and then fail
        // the `related.context` guard below, so a catalog listing both "gpt-4o"
        // (bare) and "openai/gpt-4o" (with the window) answered "no window".
        const exact = models.find((m) => m.id.toLowerCase() === want && m.context);
        // Segment-aware equivalence, not substrings — "gpt-4o" must not match "gpt-4o-mini"
        const related =
          exact ||
          models.find((m) => m.context && modelIdsRelated(m.id, model)) ||
          models.find((m) => m.id.toLowerCase() === want);
        if (related && related.context) {
          context = related.context;
          matchedId = related.id;
        }
      }

      // Big aggregators list well over a thousand models; truncating at 500
      // used to make the client's catalog check report perfectly valid ids as
      // "not found". `count` is always the real total so the client can say so.
      const sent = models.slice(0, MODEL_LIST_CAP);
      sendJson({
        ok: true,
        count: models.length,
        truncated: models.length > sent.length,
        models: sent,
        context,
        matchedId,
        source: 'provider'
      });
    });
  });

  // A catalog fetch the browser walked away from should not keep an upstream
  // socket open for the full MODELS_TIMEOUT_MS — handleChat has always done
  // this on its own response; this is the same courtesy for /models.
  res.on('close', () => {
    if (!responded) upstream.destroy();
  });

  upstream.on('timeout', () => {
    upstream.destroy();
    sendJson({ ok: false, error: 'Upstream /models timed out', models: [], context: null });
  });

  upstream.on('error', (err) => {
    sendJson({
      ok: false,
      error: err.message || 'Failed to reach /models',
      models: [],
      context: null
    });
  });

  upstream.end();
}

module.exports = {
  handleChat, handleModels,
  extractText, normalizeBaseUrl, headerSafeApiKey, clampTemperature, clampMaxTokens,
  reasoningVariants, splitModelId, modelIdsRelated, pickContextLength, decodeBody,
  MODEL_LIST_CAP
};
