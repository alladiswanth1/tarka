'use strict';
/**
 * The trust boundary. Every case here maps to something an attacker would try,
 * or to a Node behaviour change that silently broke a guard.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  isPrivateIp,
  isIpLiteral,
  isBlockedInternalHostname,
  hostnameFromHeader,
  isTrustedHostHeader,
  isSameOriginRequest,
  isCsrfSafeContentType,
  applyPinnedLookup
} = require('../lib/security');

test('isPrivateIp: IPv4 ranges', () => {
  const priv = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255',
    '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.1.1.1',
    '240.0.0.1', '255.255.255.255', '192.0.0.1', '192.0.2.5',
    '198.18.0.1', '198.19.0.1', '198.51.100.7', '203.0.113.9'
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} should be private`);

  const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.255.255',
    '100.128.0.1', '11.0.0.1', '193.0.0.1', '198.20.0.1', '203.0.114.1'];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
});

test('isPrivateIp: malformed IPv4 is blocked, not allowed', () => {
  assert.equal(isPrivateIp('999.1.1.1'), true);
  assert.equal(isPrivateIp('256.256.256.256'), true);
  assert.equal(isPrivateIp(''), true);
  assert.equal(isPrivateIp(null), true);
});

test('isPrivateIp: IPv6 loopback, ULA and link-local', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::1', '[::1]', 'fe80::1%eth0']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('isPrivateIp: IPv4-mapped / -compatible / NAT64 embeddings cannot smuggle loopback', () => {
  const smuggled = [
    '::ffff:127.0.0.1',   // mapped, dotted
    '::ffff:7f00:1',      // mapped, hex
    '::ffff:169.254.169.254',
    '::ffff:a00:1',       // 10.0.0.1
    '::127.0.0.1',        // deprecated IPv4-compatible
    '64:ff9b::127.0.0.1', // NAT64
    '64:ff9b::7f00:1',
    '64:ff9b::1',         // other NAT64 forms blocked conservatively
    '::ffff:7f00'         // ambiguous bare-hex tail
  ];
  for (const ip of smuggled) assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  // A mapped PUBLIC address is still public
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
});

test('isIpLiteral', () => {
  assert.equal(isIpLiteral('127.0.0.1'), true);
  assert.equal(isIpLiteral('[::1]'), true);
  assert.equal(isIpLiteral('example.com'), false);
  assert.equal(isIpLiteral(''), false);
});

test('isBlockedInternalHostname', () => {
  for (const h of ['localhost', 'foo.localhost', '0.0.0.0', '::', '127.0.0.1', '[::1]', '169.254.169.254']) {
    assert.equal(isBlockedInternalHostname(h), true, h);
  }
  for (const h of ['openrouter.ai', 'api.tokenrouter.com', '8.8.8.8']) {
    assert.equal(isBlockedInternalHostname(h), false, h);
  }
});

test('hostnameFromHeader strips port, brackets and scheme', () => {
  assert.equal(hostnameFromHeader('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(hostnameFromHeader('[::1]:3000'), '::1');
  assert.equal(hostnameFromHeader('http://Example.COM/x'), 'example.com');
  assert.equal(hostnameFromHeader(''), '');
});

test('isTrustedHostHeader: DNS-rebinding defense', () => {
  const withHost = (host) => ({ headers: host === undefined ? {} : { host } });
  assert.equal(isTrustedHostHeader(withHost('127.0.0.1:3000')), true);
  assert.equal(isTrustedHostHeader(withHost('[::1]:3000')), true);
  assert.equal(isTrustedHostHeader(withHost('localhost:3000')), true);
  assert.equal(isTrustedHostHeader(withHost('macbook.local')), true);
  assert.equal(isTrustedHostHeader(withHost('192.168.1.20:3000')), true);
  // A registrable domain is exactly the rebinding vector this blocks
  assert.equal(isTrustedHostHeader(withHost('evil.example.com')), false);
  assert.equal(isTrustedHostHeader(withHost('tarka.example.com')), false);
  // No Host at all cannot be a browser, so it is not the vector
  assert.equal(isTrustedHostHeader(withHost(undefined)), true);
});

test('isSameOriginRequest: cross-site fetches are refused', () => {
  const req = (headers) => ({ headers });
  assert.equal(isSameOriginRequest(req({})), true);
  assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': 'none' })), true);
  assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': 'same-site' })), false);
  assert.equal(isSameOriginRequest(req({ origin: 'null' })), false);
  assert.equal(
    isSameOriginRequest(req({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' })),
    true
  );
  assert.equal(
    isSameOriginRequest(req({ origin: 'http://evil.example', host: '127.0.0.1:3000' })),
    false
  );
  // Another local port is another origin
  assert.equal(
    isSameOriginRequest(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3000' })),
    false
  );
});

test('isCsrfSafeContentType rejects the simple-request body types', () => {
  const req = (ct) => ({ headers: ct === undefined ? {} : { 'content-type': ct } });
  assert.equal(isCsrfSafeContentType(req('application/json')), true);
  assert.equal(isCsrfSafeContentType(req('application/json; charset=utf-8')), true);
  assert.equal(isCsrfSafeContentType(req(undefined)), true); // curl / scripts
  assert.equal(isCsrfSafeContentType(req('text/plain')), false);
  assert.equal(isCsrfSafeContentType(req('multipart/form-data; boundary=x')), false);
  assert.equal(isCsrfSafeContentType(req('application/x-www-form-urlencoded')), false);
});

/*
 * Regression: since Node 20, autoSelectFamily defaults on, so `net` calls a
 * custom lookup with { all: true } and expects an ARRAY. Answering with the
 * (err, address, family) form made every proxied request from a non-loopback
 * client fail with ERR_INVALID_IP_ADDRESS before it left the machine.
 */
test('applyPinnedLookup answers the array form when net asks for all', (t, done) => {
  const opts = applyPinnedLookup({}, { address: '203.0.113.5', family: 4 });
  opts.lookup('example.com', { all: true }, (err, addresses) => {
    assert.ifError(err);
    assert.ok(Array.isArray(addresses), 'must be an array when opts.all is set');
    assert.deepEqual(addresses, [{ address: '203.0.113.5', family: 4 }]);
    done();
  });
});

test('applyPinnedLookup still answers the legacy 3-arg form', (t, done) => {
  const opts = applyPinnedLookup({}, { address: '203.0.113.5', family: 4 });
  opts.lookup('example.com', {}, (err, address, family) => {
    assert.ifError(err);
    assert.equal(address, '203.0.113.5');
    assert.equal(family, 4);
    done();
  });
});

test('applyPinnedLookup handles the (hostname, cb) overload', (t, done) => {
  const opts = applyPinnedLookup({}, { address: '::1', family: 6 });
  opts.lookup('example.com', (err, address, family) => {
    assert.ifError(err);
    assert.equal(address, '::1');
    assert.equal(family, 6);
    done();
  });
});

test('applyPinnedLookup passes every validated address through', (t, done) => {
  const pin = {
    address: '203.0.113.5',
    family: 4,
    addresses: [{ address: '2001:db8::1', family: 6 }, { address: '203.0.113.5', family: 4 }]
  };
  const opts = applyPinnedLookup({}, pin);
  opts.lookup('example.com', { all: true }, (err, addresses) => {
    assert.ifError(err);
    assert.equal(addresses.length, 2);
    done();
  });
});

test('applyPinnedLookup is a no-op without a pin (loopback clients)', () => {
  const opts = applyPinnedLookup({ hostname: 'x' }, null);
  assert.equal(opts.lookup, undefined);
});

/* An actual socket connect proves the callback contract, not just its shape. */
test('a pinned request completes end to end', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const body = await new Promise((resolve, reject) => {
      const options = applyPinnedLookup(
        { hostname: 'pinned.invalid', port, path: '/', method: 'GET' },
        { address: '127.0.0.1', family: 4 }
      );
      const rq = http.request(options, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      });
      rq.on('error', reject);
      rq.end();
    });
    assert.equal(body, '{"ok":true}');
  } finally {
    srv.close();
  }
});

/*
 * Regression: classification must be canonical-form-independent. The old
 * string-prefix heuristics saw only the first hextet of uncompressed forms —
 * "0:0:0:0:0:0:0:1" (loopback, as inet_ntop never prints it) came back public.
 */
test('isPrivateIp: non-canonical IPv6 spellings classify like their canonical forms', () => {
  const priv = [
    '0:0:0:0:0:0:0:1', // ::1 uncompressed
    '0::1',
    '0:0:0:0:0:0:0:0', // :: uncompressed
    '0:0:0:0:0:ffff:7f00:1', // ::ffff:127.0.0.1 in hex groups
    '0:0:0:0:0:ffff:127.0.0.1', // mapped with dotted tail
    'fe80:0:0:0:0:0:0:1', // link-local uncompressed
    'fc00:0:0:0:0:0:0:1', // ULA uncompressed
    '64:ff9b:0:0:0:0:7f00:1', // NAT64-embedded loopback, uncompressed
    '64:ff9b:1::1' // outside the /96 — blocked conservatively
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  const pub = [
    '0:0:0:0:0:ffff:808:808', // ::ffff:8.8.8.8
    '2606:4700:0:0:0:0:0:1111', // 1.1.1.1's AAAA, uncompressed
    '64:ff9b:0:0:0:0:808:808' // NAT64-embedded 8.8.8.8
  ];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  // Unparseable IPv6 fails closed
  assert.equal(isPrivateIp('1:2:3:4:5:6:7:8:9'), true);
  assert.equal(isPrivateIp('::gggg'), true);
});
