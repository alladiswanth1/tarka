'use strict';
/**
 * The trust boundary. Tarka is a forwarding proxy that also runs shell
 * commands, so these checks are what stand between a web page you happen to
 * visit and your filesystem: same-origin enforcement, Host-header pinning
 * against DNS rebinding, and SSRF containment for the proxy target.
 *
 * Every function here is pure and dependency-free — the highest-value place
 * in the repo to add tests.
 */
const dns = require('dns');
const { sendJsonRes } = require('./http');
const { EXTRA_ALLOWED_HOSTS } = require('./config');

/** True when the HTTP client is on loopback (local browser → this server). */
function isLoopbackRemote(req) {
  const raw = req.socket && req.socket.remoteAddress;
  if (!raw) return false;
  // Node may report IPv4-mapped IPv6 as ::ffff:127.0.0.1
  const addr = String(raw).replace(/^::ffff:/i, '').toLowerCase();
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
}

/** True when the string is an IPv4 or IPv6 literal (brackets optional). */
function isIpLiteral(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // IPv6 (including compressed / mapped forms)
  if (h.includes(':')) return true;
  return false;
}

/**
 * Parse an IPv6 literal into its 8 numeric hextets, or null when malformed.
 * Handles `::` compression and a trailing embedded dotted-quad. Numeric
 * parsing is what makes classification canonical-form-independent:
 * "0:0:0:0:0:0:0:1", "0::1" and "::1" all yield the same groups.
 */
function parseIpv6Groups(raw) {
  let h = String(raw || '');
  if (!h || h.includes(':::')) return null;
  // Fold a trailing dotted-quad into two hextets first ("::ffff:127.0.0.1")
  const v4 = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const oct = v4[1].split('.').map(Number);
    if (oct.some((n) => n > 255)) return null;
    h =
      h.slice(0, -v4[1].length) +
      (((oct[0] << 8) | oct[1]).toString(16) + ':' + (((oct[2] << 8) | oct[3])).toString(16));
  }
  const dbl = h.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  let groups;
  if (dbl.length === 1) {
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null; // "::" must stand for ≥1 group
    groups = [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

/**
 * Shared private/internal IP check for both literal hostnames and DNS results.
 * Covers RFC1918, loopback, link-local, CGNAT, IPv6 ULA/link-local, IPv4-mapped.
 * IPv6 is classified from parsed hextets, never string prefixes — an
 * uncompressed loopback ("0:0:0:0:0:0:0:1") must classify exactly like "::1".
 */
function isPrivateIp(ip) {
  let h = String(ip || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]; // drop zone id

  if (!h) return true;

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.some((n) => n > 255)) return true; // treat malformed as blocked
    const [a, b, c] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // special-purpose + TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    return false;
  }

  // IPv6
  if (h.includes(':')) {
    const g = parseIpv6Groups(h);
    if (!g) return true; // unparseable → block conservatively
    const embedded = () =>
      `${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`;
    // unspecified :: / loopback ::1
    if (g.every((x) => x === 0)) return true;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    // IPv4-mapped ::ffff:a.b.c.d → judge the embedded IPv4
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateIp(embedded());
    // IPv4-compatible ::/96 (deprecated) → embeds 0.0.x.y or a real IPv4
    if (g.slice(0, 6).every((x) => x === 0)) return isPrivateIp(embedded());
    // NAT64 64:ff9b::/96 → judge the embedded IPv4; other 64:ff9b forms block
    if (g[0] === 0x64 && g[1] === 0xff9b) {
      return g.slice(2, 6).every((x) => x === 0) ? isPrivateIp(embedded()) : true;
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits, and Teredo
    // 2001:0::/32 embeds the server's. Both are ways to spell an internal IPv4
    // target in IPv6, exactly like the ::ffff: form handled above — judge what
    // they carry rather than letting the outer prefix look public.
    if (g[0] === 0x2002) {
      return isPrivateIp(`${(g[1] >> 8) & 255}.${g[1] & 255}.${(g[2] >> 8) & 255}.${g[2] & 255}`);
    }
    if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo 2001::/32
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8 (IPv4's is blocked too)
    if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only 100::/64
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation 2001:db8::/32
    return false;
  }

  return false;
}

/**
 * Block obvious internal / metadata targets for remote clients.
 * Local Ollama/vLLM from the same machine remains allowed when the
 * request itself arrives from loopback.
 */
function isBlockedInternalHostname(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ''); // strip IPv6 brackets if present

  if (!h) return true;

  // Explicit loopback / unspecified hostnames
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::') {
    return true;
  }

  // IP literals (IPv4 / IPv6 / mapped) via shared helper
  if (isIpLiteral(h) && isPrivateIp(h)) return true;

  return false;
}

/** Hostname of a `Host:`/`Origin:` value, brackets stripped, port dropped. */
function hostnameFromHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(`http://${raw.replace(/^https?:\/\//i, '')}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * Anti-DNS-rebinding: a local server that runs shell commands is a prime
 * rebinding target — an attacker's page whose domain re-resolves to 127.0.0.1
 * becomes same-origin with this server and can then read every response.
 * Rebinding always arrives under a registrable domain, so requiring the Host
 * header to be an IP literal, `localhost`, or an mDNS `.local` name defeats it
 * while leaving loopback and LAN-by-IP access untouched. Set
 * TARKA_ALLOWED_HOSTS for anything else (e.g. a reverse-proxy domain).
 */
function isTrustedHostHeader(req) {
  const raw = req.headers.host;
  // Browsers always send Host; exotic HTTP/1.0 clients that don't cannot be
  // the rebinding vector this check exists for.
  if (!raw) return true;
  const h = hostnameFromHeader(raw);
  if (!h) return false;
  if (EXTRA_ALLOWED_HOSTS.has('*') || EXTRA_ALLOWED_HOSTS.has(h)) return true;
  // "*.example.com" is the obvious way to write a wildcard, and the docs point
  // at reverse-proxy domains — but only exact entries were ever compared, so a
  // wildcard silently matched nothing and 403'd every request with no clue why.
  for (const entry of EXTRA_ALLOWED_HOSTS) {
    if (entry.startsWith('*.') && (h === entry.slice(2) || h.endsWith(entry.slice(1)))) {
      return true;
    }
  }
  if (isIpLiteral(h)) return true; // 127.0.0.1, ::1, and LAN addresses
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true; // mDNS / Bonjour names
  return false;
}

/**
 * True when the request is NOT a cross-site browser request. Any page the user
 * visits can POST to 127.0.0.1 without a preflight (a "simple request"), which
 * would otherwise let a random website drive Project Mode. `Origin` is present
 * on every cross-origin state-changing fetch and `Sec-Fetch-Site` covers GETs;
 * non-browser clients (curl, scripts) send neither and stay allowed.
 */
function isSameOriginRequest(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  // "none" = user-initiated (typed URL / bookmark); anything else that isn't
  // same-origin is another site or another local port.
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    if (origin === 'null') return false; // sandboxed frame / data: document
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== String(req.headers.host || '').trim().toLowerCase()) return false;
  }
  return true;
}

/**
 * Reject the body types a cross-site form or simple `fetch` can send. Tarka's
 * own client always posts application/json; tools that omit the header are
 * still accepted so scripting the API stays easy.
 */
function isCsrfSafeContentType(req) {
  const ct = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!ct) return true;
  return !(
    ct === 'application/x-www-form-urlencoded' ||
    ct === 'multipart/form-data' ||
    ct === 'text/plain'
  );
}

/**
 * Validate proxy target. For non-loopback clients, also resolve DNS and reject
 * if any address is private (prevents public-hostname → private-IP bypass).
 * Returns a pin object { address, family } for lib.request custom lookup, or null.
 */
async function assertProxyTargetAllowed(req, targetUrl) {
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    const err = new Error('Base URL must be http or https');
    err.statusCode = 400;
    throw err;
  }

  const hostname = String(targetUrl.hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const fromLoopback = isLoopbackRemote(req);

  // Allow local targets only when the caller is also local
  if (isBlockedInternalHostname(hostname) && !fromLoopback) {
    const err = new Error(
      'Refusing to proxy to internal/private host from a non-loopback client'
    );
    err.statusCode = 403;
    throw err;
  }

  // Loopback clients may reach private targets (local Ollama/vLLM) — no pin
  if (fromLoopback) return null;

  // IP literals already validated above; pin the connection to that address
  if (isIpLiteral(hostname)) {
    const family = hostname.includes(':') ? 6 : 4;
    return { address: hostname, family, addresses: [{ address: hostname, family }] };
  }

  // Resolve DNS and reject if ANY address is private (DNS rebinding defense)
  let results;
  try {
    results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    const err = new Error(`Could not resolve host: ${hostname}`);
    err.statusCode = 400;
    throw err;
  }
  if (!results || !results.length) {
    const err = new Error(`Could not resolve host: ${hostname}`);
    err.statusCode = 400;
    throw err;
  }
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      const err = new Error(
        'Refusing to proxy to internal/private host from a non-loopback client'
      );
      err.statusCode = 403;
      throw err;
    }
  }
  // Pin to the already-validated addresses (TOCTOU / rebinding mitigation).
  // Every entry passed isPrivateIp above, so handing Node the whole set is as
  // safe as handing it one — and it keeps happy-eyeballs working on hosts where
  // the first record is an unroutable AAAA.
  const addresses = results.map((r) => ({
    address: r.address,
    family: r.family || (String(r.address).includes(':') ? 6 : 4)
  }));
  return { address: addresses[0].address, family: addresses[0].family, addresses };
}

/**
 * Attach a custom lookup that pins the TCP connection to a pre-validated address.
 *
 * The callback shape is NOT fixed — it depends on what `net` asked for. Since
 * Node 20, `autoSelectFamily` defaults to true, so `net` calls the lookup with
 * `{ all: true }` and expects an ARRAY of `{ address, family }`. Answering that
 * with the three-argument `(err, address, family)` form makes Node read
 * `addresses[0].address` off a string and fail the connection with
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` — i.e. every proxied
 * request from a non-loopback client dies before it leaves the machine.
 * Honour `opts.all` and both shapes stay correct across Node versions.
 */
function applyPinnedLookup(options, pin) {
  if (!pin || !pin.address) return options;
  const address = pin.address;
  const family = pin.family || (String(address).includes(':') ? 6 : 4);
  const all = Array.isArray(pin.addresses) && pin.addresses.length
    ? pin.addresses
    : [{ address, family }];
  options.lookup = (hostname, opts, cb) => {
    // Node may call with (hostname, cb) when opts is omitted
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (opts && opts.all) {
      cb(null, all);
      return;
    }
    cb(null, address, family);
  };
  return options;
}

/** Project endpoints are loopback-only regardless of the bind address. */
function assertLoopback(req, res) {
  if (isLoopbackRemote(req)) return true;
  sendJsonRes(res, 403, { error: 'Project Mode endpoints are available from this machine only' });
  return false;
}

module.exports = {
  isLoopbackRemote, isIpLiteral, isPrivateIp, isBlockedInternalHostname,
  hostnameFromHeader, isTrustedHostHeader, isSameOriginRequest, isCsrfSafeContentType,
  assertProxyTargetAllowed, applyPinnedLookup, assertLoopback
};
