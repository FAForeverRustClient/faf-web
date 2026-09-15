'use strict';

/**
 * Self-contained suite. Unit-tests the two pieces that carry the risk (the
 * upstream allowlist and the static path resolver), then boots the real server
 * over real HTTP for the routing and header behaviour.
 *
 * No network is required. The proxy's upstream fetch is injectable, so every
 * branch is driven with a stub rather than by hoping api.faforever.com answers.
 *
 *   node webtest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { resolve } = require('./lib/upstreams');
const { createCache, proxyGet, UPSTREAM_HEADERS } = require('./lib/proxy');
const { resolveFile } = require('./lib/static');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? '  -> ' + detail : ''));
  return false;
}
function eq(a, b, name) {
  return ok(a === b, name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

/* ------------------------------------------------- the allowlist (security) */

function testUpstreams() {
  const good = resolve('faf', 'map', '?page%5Bsize%5D=5');
  ok(good !== null, 'upstream: an allowlisted resource resolves');
  ok(good && good.url === 'https://api.faforever.com/data/map?page%5Bsize%5D=5',
    'upstream: the URL is rebuilt on our side, query preserved', good && good.url);

  eq(resolve('faf', 'secretThing', ''), null, 'upstream: a resource not on the allowlist is refused');
  eq(resolve('nope', 'map', ''), null, 'upstream: an unknown route is refused');
  eq(resolve('faf', '../../etc/passwd', ''), null, 'upstream: traversal is refused');
  eq(resolve('faf', 'map/../../x', ''), null, 'upstream: traversal mid-path is refused');
  eq(resolve('faf', '/data/map', ''), null, 'upstream: a leading slash is refused');
  eq(resolve('faf', 'evil.com/x', ''), null, 'upstream: a host-looking segment is refused');
  eq(resolve('faf', 'map%00', ''), null, 'upstream: percent escapes are refused');
  eq(resolve('faf', 'map\\x', ''), null, 'upstream: backslashes are refused');
  eq(resolve('faf', '', ''), null, 'upstream: an empty path is refused');

  // The open-relay check: nothing a caller sends may change the target host.
  const sneaky = resolve('faf', 'map', '?x=1#@evil.com');
  ok(!sneaky || sneaky.url.startsWith('https://api.faforever.com/'),
    'upstream: the caller cannot redirect the request to another host', sneaky && sneaky.url);

  const ev = resolve('events', 'calendar.json', '');
  ok(ev && ev.url === 'https://raw.githubusercontent.com/FAForeverRustClient/events/main/calendar.json',
    'upstream: the events calendar resolves', ev && ev.url);
  eq(resolve('events', 'other.json', ''), null, 'upstream: only the calendar file is reachable');

  const t = resolve('tourney', 'tournaments', '');
  ok(t && t.url === 'https://tournaments.doodlepros.com/api/tournaments',
    'upstream: the tourney API resolves', t && t.url);
}

/* ------------------------------------------------ static paths (security) */

function testStaticPaths() {
  const root = path.resolve(__dirname, 'public');
  ok(resolveFile(root, '/index.html') !== null, 'static: index.html resolves');
  ok(resolveFile(root, '/') !== null, 'static: / resolves to the index');
  eq(resolveFile(root, '/../server.js'), null, 'static: traversal out of public/ is refused');
  eq(resolveFile(root, '/../../etc/passwd'), null, 'static: deep traversal is refused');
  eq(resolveFile(root, '/%2e%2e/server.js'), null, 'static: encoded traversal is refused');
  eq(resolveFile(root, '/app.js%00.png'), null, 'static: a null byte is refused');
  eq(resolveFile(root, '/does-not-exist.css'), null, 'static: a missing file is null');

  const js = resolveFile(root, '/app.js');
  ok(js && /text\/javascript/.test(js.type), 'static: app.js gets a javascript content type');
}

/* -------------------------------------------------------- proxy behaviour */

async function testProxy() {
  const cache = createCache();
  let calls = 0;
  let seenOpts = null;

  const stub = (url, opts) => {
    calls++;
    seenOpts = opts;
    return Promise.resolve({
      status: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ url, n: calls }))
    });
  };

  const target = { url: 'https://api.faforever.com/data/map', ttlMs: 1000 };

  const a = await proxyGet(target, cache, { fetchImpl: stub });
  eq(a.status, 200, 'proxy: a good upstream returns 200');
  eq(a.cached, false, 'proxy: the first call is a miss');

  const b = await proxyGet(target, cache, { fetchImpl: stub });
  eq(b.cached, true, 'proxy: the second call is served from cache');
  eq(calls, 1, 'proxy: the upstream was called exactly once');

  // No credentials may ever be forwarded. This asserts on the REAL header set
  // the outgoing request uses, not on what the stub happened to receive. The
  // earlier version inspected the stub's arguments and therefore passed even
  // when an Authorization header was planted in the real request.
  const hdrNames = Object.keys(UPSTREAM_HEADERS);
  ok(!hdrNames.some((h) => /cookie|authorization|x-api-key|token/i.test(h)),
    'proxy: the upstream request carries no credential header', hdrNames.join(','));
  eq(hdrNames.length, 2, 'proxy: the upstream header set is exactly User-Agent and Accept');
  ok(seenOpts !== null, 'proxy: the stub was actually invoked');

  // Expiry.
  const shortCache = createCache();
  await proxyGet({ url: 'https://api.faforever.com/data/mod', ttlMs: 1 }, shortCache, { fetchImpl: stub });
  await new Promise((r) => setTimeout(r, 20));
  const after = await proxyGet({ url: 'https://api.faforever.com/data/mod', ttlMs: 1 }, shortCache, { fetchImpl: stub });
  eq(after.cached, false, 'proxy: an expired entry is refetched');

  // Upstream failures are reported, not cached.
  const errCache = createCache();
  const failing = () => Promise.resolve({
    status: 503, contentType: 'application/json', body: Buffer.from('{"errors":[{"detail":"down"}]}')
  });
  const e1 = await proxyGet(target, errCache, { fetchImpl: failing });
  eq(e1.status, 503, 'proxy: an upstream error status is passed through');
  const e2 = await proxyGet(target, errCache, { fetchImpl: failing });
  eq(e2.cached, false, 'proxy: failures are never cached');

  // An HTML error page is not forwarded to the browser.
  const htmlErr = () => Promise.resolve({
    status: 500, contentType: 'text/html', body: Buffer.from('<html>stack trace</html>')
  });
  const h = await proxyGet(target, createCache(), { fetchImpl: htmlErr });
  ok(!h.body.toString().includes('stack trace'), 'proxy: an upstream HTML error body is not forwarded');

  // A thrown error becomes a clean 502/504 rather than a crash.
  const boom = () => Promise.reject(Object.assign(new Error('nope'), { timeout: true }));
  const t504 = await proxyGet(target, createCache(), { fetchImpl: boom });
  eq(t504.status, 504, 'proxy: an upstream timeout becomes a 504');

  // The cache is bounded.
  const small = createCache(3);
  for (let i = 0; i < 10; i++) {
    await proxyGet({ url: 'https://api.faforever.com/data/map?i=' + i, ttlMs: 1000 }, small, { fetchImpl: stub });
  }
  ok(small.size() <= 3, 'proxy: the cache is bounded', 'size=' + small.size());
}

/* ----------------------------------------------------------- the real server */

function request(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer() {
  const port = 21000 + Math.floor(Math.random() * 10000);
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = setInterval(() => {
      if (out.includes('"msg":"listening"')) {
        clearInterval(tick);
        resolve({
          port, proc, logs: () => out,
          stop: () => new Promise((r) => { proc.once('close', r); proc.kill('SIGTERM'); })
        });
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error('server did not start: ' + out));
      }
    }, 40);
  });
}

async function testServer() {
  const s = await startServer();
  try {
    const health = await request(s.port, '/healthz');
    eq(health.status, 200, 'server: /healthz answers');
    const hj = JSON.parse(health.body);
    eq(hj.ok, true, 'server: health reports ok');
    eq(hj.playTab, false, 'server: health states plainly that there is no Play tab');

    const index = await request(s.port, '/');
    eq(index.status, 200, 'server: the app shell is served');
    ok(/text\/html/.test(index.headers['content-type']), 'server: the shell is HTML');
    ok(index.body.includes('id="view"'), 'server: the shell contains the app mount point');

    const spa = await request(s.port, '/leaderboard');
    eq(spa.status, 200, 'server: an app route falls back to the shell');
    ok(spa.body.includes('id="view"'), 'server: the fallback really is the shell');

    const missingAsset = await request(s.port, '/nope.css');
    eq(missingAsset.status, 404, 'server: a missing asset is a 404, not the shell');

    const css = await request(s.port, '/style.css');
    eq(css.status, 200, 'server: the stylesheet is served');
    ok(/text\/css/.test(css.headers['content-type']), 'server: the stylesheet has the right type');

    // Security headers.
    const csp = index.headers['content-security-policy'] || '';
    ok(/script-src 'self'/.test(csp), 'server: CSP restricts scripts to this origin');
    ok(/frame-src[^;]*faforever\.github\.io/.test(csp), 'server: CSP allows the embedded FAF pages');
    ok(!/frame-src[^;]*\*/.test(csp), 'server: CSP does not allow framing anything');
    eq(index.headers['x-content-type-options'], 'nosniff', 'server: nosniff is set');

    // API surface.
    const unknownRoute = await request(s.port, '/api/nope/x');
    eq(unknownRoute.status, 404, 'server: an unknown proxy route is 404');

    const blockedResource = await request(s.port, '/api/faf/secretThing');
    eq(blockedResource.status, 404, 'server: a non-allowlisted resource is 404');
    eq(blockedResource.body, unknownRoute.body,
      'server: blocked and unknown answer identically, so the allowlist cannot be enumerated');

    const post = await request(s.port, '/api/faf/map', 'POST');
    eq(post.status, 405, 'server: the proxy refuses anything but GET');
    ok((post.headers.allow || '').includes('GET'), 'server: the 405 names the allowed method');

    const traversal = await request(s.port, '/../server.js');
    ok(traversal.status === 404 || traversal.status === 400,
      'server: traversal does not escape public/', String(traversal.status));
    ok(!traversal.body.includes('require('), 'server: no source file leaked');

    await new Promise((r) => setTimeout(r, 150));
    ok(!s.logs().includes('Authorization'), 'server: nothing auth-shaped is logged');
  } finally {
    await s.stop();
  }
}

/* ------------------------------------------------------------------- main */

(async () => {
  console.log('faf-web suite\n');
  const blocks = [
    ['upstream allowlist', testUpstreams],
    ['static paths', testStaticPaths],
    ['proxy', testProxy],
    ['server', testServer]
  ];
  for (const [name, fn] of blocks) {
    const before = fail;
    try { await fn(); } catch (err) {
      fail++;
      failures.push(name + ': block threw -> ' + (err && err.message));
    }
    console.log('  ' + name.padEnd(20) + (fail === before ? 'ok' : 'FAILED'));
  }

  console.log('');
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    console.log('');
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('suite crashed: ' + (err && err.stack));
  process.exit(1);
});
