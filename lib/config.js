'use strict';
/** Environment-derived configuration: ports, timeouts, upstream attribution. */
const { URL } = require('url');

// Validated: Node treats a non-numeric listen() argument as a PIPE NAME, so
// `PORT=abc` used to create a Unix socket file "abc" and print a URL that
// nothing listens on. Warn and fall back instead.
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw == null || String(raw).trim() === '') return 3000;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  console.error(`✗ Ignoring invalid PORT "${raw}" — using 3000. PORT must be an integer 0-65535.`);
  return 3000;
})();
// Bind loopback by default so this open proxy is not reachable from the LAN.
// Set HOST=0.0.0.0 only if you intentionally open it to the network.
const HOST = process.env.HOST || '127.0.0.1';
/** Parse a positive-integer env var with a fallback. */
function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Upstream *idle* timeout (ms) — fires only when the upstream socket carries no
// bytes at all for this long, not on total request duration. 5 minutes, because
// a reasoning model can think for minutes before its first token and gateways
// in the one-api family (TokenRouter et al.) send NO keep-alive bytes while it
// does — OpenRouter's ": PROCESSING" comments are the exception, not the rule.
// At 120s those silent waits died as "Upstream request timed out".
const UPSTREAM_TIMEOUT_MS = positiveIntEnv('UPSTREAM_TIMEOUT_MS', 300000);
// /models catalog fetch timeout (ms) — a plain GET, so much tighter.
const MODELS_TIMEOUT_MS = positiveIntEnv('TARKA_MODELS_TIMEOUT_MS', 30000);
// Downstream SSE keep-alive comment interval (ms). While the upstream is
// silent, Tarka itself must not look dead to the browser or to any reverse
// proxy with its own idle timeout in front of it.
const SSE_KEEPALIVE_MS = positiveIntEnv('TARKA_SSE_KEEPALIVE_MS', 15000);

/** Env-supplied header values are attacker-adjacent: strip CR/LF and non-ASCII. */
function headerSafe(value, fallback) {
  const clean = String(value == null ? '' : value)
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

// App attribution for OpenRouter-style gateways. Their side keys the app on
// HTTP-Referer (the title only relabels it), so this must name the app, not the
// machine — a bare "http://localhost:3000" shows up in provider logs as an
// anonymous localhost URL indistinguishable from every other local tool.
// "*.localhost" is reserved for loopback (RFC 6761), so this stays honest about
// where Tarka runs while still reading as Tarka. Point TARKA_APP_URL at your own
// URL if you host it somewhere real.
const APP_NAME = headerSafe(process.env.TARKA_APP_NAME, 'Tarka');
const APP_URL = (() => {
  const raw = headerSafe(process.env.TARKA_APP_URL, '');
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (_) {
      /* fall through to the default */
    }
  }
  return 'http://tarka.localhost/';
})();
const ATTRIBUTION_HEADERS = {
  'HTTP-Referer': APP_URL,
  'X-OpenRouter-Title': APP_NAME, // current header name
  'X-Title': APP_NAME // legacy name, still read by OpenRouter and other gateways
};
// Extra Host headers to trust (comma separated), e.g. a reverse-proxy domain.
// "*" disables the check entirely — only do that behind your own auth.
// Entries are reduced to a bare hostname because that is what
// isTrustedHostHeader compares: an entry pasted as "host:8080" or
// "[::1]:8080" could otherwise never match and silently 403'd every request.
const EXTRA_ALLOWED_HOSTS = new Set(
  String(process.env.TARKA_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((h) => {
      if (h === '*') return h;
      // "*.example.com" must survive normalization intact — isTrustedHostHeader
      // matches it as a suffix. Feeding it to new URL() mangles the label.
      if (h.startsWith('*.')) return h;
      try {
        return new URL('http://' + h).hostname.replace(/^\[|\]$/g, '');
      } catch {
        // Bare IPv6 without brackets does not parse as a URL — keep as-is
        return h.replace(/^\[|\]$/g, '');
      }
    })
    .filter(Boolean)
);

// Bind host as it should appear inside a pasteable URL — the help page and
// startup log build "http://<this>:<port>". IPv6 literals need brackets there.
const REFERER_HOST = (() => {
  if (HOST === '0.0.0.0' || HOST === '::' || HOST === '[::]') return '127.0.0.1';
  const h = String(HOST).replace(/^\[|\]$/g, '');
  return h.includes(':') ? `[${h}]` : h;
})();

module.exports = {
  PORT, HOST, UPSTREAM_TIMEOUT_MS, MODELS_TIMEOUT_MS, SSE_KEEPALIVE_MS, REFERER_HOST,
  APP_NAME, APP_URL, ATTRIBUTION_HEADERS, EXTRA_ALLOWED_HOSTS, headerSafe
};
