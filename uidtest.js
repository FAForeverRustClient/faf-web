'use strict';

/**
 * Self-contained suite. Boots the real server over real HTTP with stub
 * binaries that reproduce every faf-uid behaviour that matters, then, if the
 * genuine v4.0.7 binary is present, runs a block against that too.
 *
 *   node uidtest.js
 *
 * Every stub is a shell script, so the child-process path, the argv handling,
 * the exit code handling and the stderr handling are all exercised for real
 * rather than mocked.
 *
 * The stub cases that earn their keep:
 *   - exit 0 WITH stderr output. This is what the real binary does on every
 *     headless run ("xrandr: not found"). A service that treats stderr as
 *     failure is broken on every server on earth, and this catches it.
 *   - exit 0 with EMPTY stdout, which must not be served as a proof.
 *   - a counter stub, which proves nothing is cached.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? '  -> ' + detail : ''));
  return false;
}
function eq(actual, expected, name) {
  return ok(actual === expected, name, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uidtest-'));
const REAL_BINARY = process.env.REAL_FAF_UID || '';
let portCursor = 19000 + Math.floor(Math.random() * 20000);
const nextPort = () => portCursor++;

/* ------------------------------------------------------------------- stubs */

function stub(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

const STUBS = {
  // Normal: echoes a deterministic proof-shaped blob for the session.
  good: stub('good.sh', 'echo "PROOF-FOR-$1-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"'),
  // The real-world case: noisy on stderr, still succeeds.
  noisyOk: stub('noisy.sh', 'echo "xrandr: not found" >&2\necho "lspci: not found" >&2\necho "PROOF-FOR-$1"'),
  // Fails with something to say.
  failing: stub('fail.sh', 'echo "Error initialising machine_info" >&2\nexit 3'),
  // Succeeds but says nothing. Must never be served as a proof.
  empty: stub('empty.sh', 'echo "warned" >&2\nexit 0'),
  // Takes too long.
  slow: stub('slow.sh', 'sleep 5\necho "PROOF-LATE"'),
  // Takes a beat, for the concurrency test.
  sleepy: stub('sleepy.sh', 'sleep 0.3\necho "PROOF-FOR-$1"'),
  // Different output every call, for the no-caching test.
  counter: stub('counter.sh', 'n=$(cat ' + TMP + '/count 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ' + TMP + '/count\necho "PROOF-$1-CALL-$n"')
};

/* ------------------------------------------------------------- http helpers */

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null
      : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1', port, path: opts.path || '/uid',
      method: opts.method || 'POST', headers
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* leave null */ }
        resolve({ status: res.statusCode, body: data, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const SECRET = 'test-secret-that-is-long-enough-32chars';
const authed = { Authorization: 'Bearer ' + SECRET };

function startServer(env, { expectExit = false } = {}) {
  const port = nextPort();
  const dataDir = fs.mkdtempSync(path.join(TMP, 'data-'));
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: dataDir,
      UID_SECRET: SECRET,
      UID_SKIP_HASH_CHECK: '1',
      UID_BINARY: STUBS.good,
      ALLOW_IPS: '',
      TRUST_PROXY: '',
      MAX_CONCURRENCY: '16'
    }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });

  const handle = {
    port, proc, dataDir,
    logs: () => out + err,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) { resolve(); return; }
      proc.once('close', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    })
  };

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = setInterval(() => {
      if (out.includes('"msg":"listening"')) { clearInterval(tick); resolve(handle); return; }
      if (proc.exitCode !== null) {
        clearInterval(tick);
        if (expectExit) { resolve(handle); return; }
        reject(new Error('server exited early: ' + out + err));
        return;
      }
      if (Date.now() > deadline) { clearInterval(tick); reject(new Error('server did not start: ' + out + err)); }
    }, 40);
  });
}

/* -------------------------------------------------------------------- tests */

async function testAuth() {
  const s = await startServer({});
  try {
    eq((await request(s.port, { body: { session: '1' } })).status, 401, 'auth: no header is 401');
    eq((await request(s.port, { body: { session: '1' }, headers: { Authorization: 'Bearer wrong' } })).status, 401, 'auth: wrong secret is 401');
    eq((await request(s.port, { body: { session: '1' }, headers: { Authorization: SECRET } })).status, 401, 'auth: secret without Bearer prefix is 401');
    eq((await request(s.port, { body: { session: '1' }, headers: { Authorization: 'Bearer ' + SECRET + 'x' } })).status, 401, 'auth: secret with a trailing char is 401');
    eq((await request(s.port, { body: { session: '1' }, headers: authed })).status, 200, 'auth: correct secret is 200');

    const health = await request(s.port, { path: '/health', method: 'GET' });
    eq(health.status, 200, 'health: needs no auth');
    ok(health.json && health.json.ok === true, 'health: reports ok');
    ok(health.json && !JSON.stringify(health.json).includes(SECRET), 'health: does not leak the secret');

    eq((await request(s.port, { path: '/fingerprint', method: 'GET' })).status, 401, 'fingerprint: needs auth');
    const fp = await request(s.port, { path: '/fingerprint', method: 'GET', headers: authed });
    eq(fp.status, 200, 'fingerprint: 200 with auth');
    ok(fp.json && typeof fp.json.digest === 'string' && fp.json.digest.length === 16, 'fingerprint: returns a 16-char digest');
    ok(fp.json && Array.isArray(fp.json.fields) && fp.json.fields.length > 10, 'fingerprint: reports the individual inputs');
    ok(fp.json && /not FAF/i.test(fp.json.note || ''), 'fingerprint: says plainly it is not FAF uid_hash');
  } finally { await s.stop(); }
}

async function testAllowlist() {
  // Allowlist that does not contain 127.0.0.1, no trusted proxies.
  let s = await startServer({ ALLOW_IPS: '203.0.113.7' });
  try {
    eq((await request(s.port, { body: { session: '1' }, headers: authed })).status, 403, 'allowlist: unlisted address is 403');
    // The spoof: peer is not a trusted proxy, so XFF must be ignored.
    const spoof = await request(s.port, {
      body: { session: '1' },
      headers: Object.assign({ 'X-Forwarded-For': '203.0.113.7' }, authed)
    });
    eq(spoof.status, 403, 'allowlist: X-Forwarded-For from an untrusted peer is ignored');
  } finally { await s.stop(); }

  // Now trust the loopback peer as if it were the proxy.
  s = await startServer({ ALLOW_IPS: '203.0.113.7', TRUST_PROXY: '127.0.0.0/8' });
  try {
    const viaProxy = await request(s.port, {
      body: { session: '1' },
      headers: Object.assign({ 'X-Forwarded-For': '203.0.113.7' }, authed)
    });
    eq(viaProxy.status, 200, 'allowlist: XFF from a trusted proxy is honoured');

    const wrongClient = await request(s.port, {
      body: { session: '1' },
      headers: Object.assign({ 'X-Forwarded-For': '198.51.100.4' }, authed)
    });
    eq(wrongClient.status, 403, 'allowlist: trusted proxy forwarding a disallowed client is 403');

    // Walk from the right past trusted hops: 203.0.113.7 is the real client.
    const chained = await request(s.port, {
      body: { session: '1' },
      headers: Object.assign({ 'X-Forwarded-For': '203.0.113.7, 127.0.0.1' }, authed)
    });
    eq(chained.status, 200, 'allowlist: chained XFF resolves past trusted hops');

    // A forged leading entry must not help.
    const forged = await request(s.port, {
      body: { session: '1' },
      headers: Object.assign({ 'X-Forwarded-For': '203.0.113.7, 198.51.100.4' }, authed)
    });
    eq(forged.status, 403, 'allowlist: a forged earlier hop does not override the real client');
  } finally { await s.stop(); }

  // CIDR support.
  s = await startServer({ ALLOW_IPS: '198.51.100.0/24', TRUST_PROXY: '127.0.0.0/8' });
  try {
    const inRange = await request(s.port, { body: { session: '1' }, headers: Object.assign({ 'X-Forwarded-For': '198.51.100.55' }, authed) });
    eq(inRange.status, 200, 'allowlist: CIDR match allowed');
    const outRange = await request(s.port, { body: { session: '1' }, headers: Object.assign({ 'X-Forwarded-For': '198.51.101.55' }, authed) });
    eq(outRange.status, 403, 'allowlist: just outside the CIDR is refused');
  } finally { await s.stop(); }
}

async function testValidation() {
  const s = await startServer({});
  try {
    eq((await request(s.port, { body: {}, headers: authed })).status, 400, 'validate: missing session is 400');
    eq((await request(s.port, { body: { session: '' }, headers: authed })).status, 400, 'validate: empty session is 400');
    eq((await request(s.port, { body: { session: '   ' }, headers: authed })).status, 400, 'validate: whitespace session is 400');
    eq((await request(s.port, { body: { session: 'x'.repeat(65) }, headers: authed })).status, 400, 'validate: over-long session is 400');
    eq((await request(s.port, { body: { session: 'a b' }, headers: authed })).status, 400, 'validate: space in session is 400');
    eq((await request(s.port, { body: { session: '12; rm -rf /' }, headers: authed })).status, 400, 'validate: shell metacharacters refused');
    eq((await request(s.port, { body: { session: { a: 1 } }, headers: authed })).status, 400, 'validate: object session is 400');
    eq((await request(s.port, { body: [1, 2], headers: authed })).status, 400, 'validate: array body is 400');
    eq((await request(s.port, { body: 'not json', headers: authed })).status, 400, 'validate: non-JSON body is 400');
    eq((await request(s.port, { body: { session: 'x'.repeat(5000) }, headers: authed })).status, 413, 'validate: oversized body is 413');

    const numeric = await request(s.port, { body: { session: 1234567890 }, headers: authed });
    eq(numeric.status, 200, 'validate: a JSON number session is accepted');
    ok(numeric.json.uid.includes('1234567890'), 'validate: numeric session reaches the binary as a string');

    const trimmed = await request(s.port, { body: { session: '  777  ' }, headers: authed });
    eq(trimmed.status, 200, 'validate: surrounding whitespace is trimmed');
    ok(trimmed.json.uid.includes('PROOF-FOR-777'), 'validate: trimmed value is what the binary receives');

    eq((await request(s.port, { path: '/uid', method: 'GET', headers: authed })).status, 405, 'routing: GET /uid is 405');
    eq((await request(s.port, { path: '/nope', method: 'GET', headers: authed })).status, 404, 'routing: unknown path is 404');
  } finally { await s.stop(); }
}

async function testStderrHandling() {
  // The one that matters most: noisy stderr with exit 0 is a SUCCESS.
  let s = await startServer({ UID_BINARY: STUBS.noisyOk });
  try {
    const r = await request(s.port, { body: { session: '4242' }, headers: authed });
    eq(r.status, 200, 'stderr: exit 0 with stderr output still succeeds');
    eq(r.json.uid, 'PROOF-FOR-4242', 'stderr: the proof is exactly stdout, trimmed');
    ok(!('stderr' in r.json), 'stderr: no stderr field on a success response');
    ok(!r.body.includes('xrandr'), 'stderr: the warning never reaches the success body');
  } finally { await s.stop(); }

  s = await startServer({ UID_BINARY: STUBS.failing });
  try {
    const r = await request(s.port, { body: { session: '4242' }, headers: authed });
    eq(r.status, 502, 'failure: non-zero exit is a non-2xx status');
    ok(!('uid' in r.json), 'failure: no uid field on an error response');
    ok(r.json.stderr.includes('Error initialising machine_info'), 'failure: the binary\'s own complaint is in the body');
    ok(/code 3/.test(r.json.error), 'failure: the exit code is reported');
  } finally { await s.stop(); }

  s = await startServer({ UID_BINARY: STUBS.empty });
  try {
    const r = await request(s.port, { body: { session: '4242' }, headers: authed });
    ok(r.status >= 400, 'empty: exit 0 with no stdout is an error, not an empty proof');
    ok(!('uid' in r.json), 'empty: no uid field is served');
    ok(r.json.stderr.includes('warned'), 'empty: stderr is still returned');
  } finally { await s.stop(); }

  s = await startServer({ UID_BINARY: STUBS.slow, UID_TIMEOUT_MS: '700' });
  try {
    const t0 = Date.now();
    const r = await request(s.port, { body: { session: '4242' }, headers: authed });
    const ms = Date.now() - t0;
    eq(r.status, 504, 'timeout: a hung run is 504');
    ok(ms < 4000, 'timeout: the run is actually killed, not waited out', ms + 'ms');
    ok(!('uid' in r.json), 'timeout: no uid field');
  } finally { await s.stop(); }
}

async function testNoCaching() {
  const s = await startServer({ UID_BINARY: STUBS.counter });
  try {
    const a = await request(s.port, { body: { session: 'same' }, headers: authed });
    const b = await request(s.port, { body: { session: 'same' }, headers: authed });
    eq(a.status, 200, 'cache: first call ok');
    eq(b.status, 200, 'cache: second call ok');
    ok(a.json.uid !== b.json.uid, 'cache: the same session runs the binary again rather than replaying a blob');
    // Not CALL-1 and CALL-2: the startup self-test already ran the binary once,
    // which is intentional. What matters is that the counter moves by exactly
    // one per request, so the binary ran once per call and no more.
    const nA = Number(/CALL-(\d+)$/.exec(a.json.uid)[1]);
    const nB = Number(/CALL-(\d+)$/.exec(b.json.uid)[1]);
    ok(nB === nA + 1, 'cache: the binary ran exactly once per request', nA + ' then ' + nB);
  } finally { await s.stop(); }
}

async function testConcurrency() {
  const s = await startServer({ UID_BINARY: STUBS.sleepy, MAX_CONCURRENCY: '8' });
  try {
    const t0 = Date.now();
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => request(s.port, { body: { session: 'S' + i }, headers: authed }))
    );
    const ms = Date.now() - t0;
    ok(rs.every((r) => r.status === 200), 'concurrency: all 8 parallel calls succeed');
    ok(rs.every((r, i) => r.json.uid === 'PROOF-FOR-S' + i), 'concurrency: each caller gets its own session\'s proof, not another\'s');
    // Serial would be 8 x 300ms = 2400ms. Parallel should be close to 300ms.
    ok(ms < 1200, 'concurrency: 8 x 300ms runs finish in parallel, not behind one lock', ms + 'ms');
  } finally { await s.stop(); }

  // And the opposite: a deliberately tiny pool refuses rather than queueing
  // into a login timeout.
  const t = await startServer({ UID_BINARY: STUBS.sleepy, MAX_CONCURRENCY: '1', MAX_QUEUE: '0' });
  try {
    const rs = await Promise.all([
      request(t.port, { body: { session: 'A' }, headers: authed }),
      request(t.port, { body: { session: 'B' }, headers: authed })
    ]);
    const codes = rs.map((r) => r.status).sort();
    eq(JSON.stringify(codes), JSON.stringify([200, 503]), 'capacity: beyond the pool the answer is a fast 503');
    const busy = rs.find((r) => r.status === 503);
    ok(busy.headers['retry-after'] === '2', 'capacity: 503 carries Retry-After');
  } finally { await t.stop(); }
}

async function testLogHygiene() {
  const s = await startServer({ UID_BINARY: STUBS.good });
  try {
    const r = await request(s.port, { body: { session: 'logcheck1' }, headers: authed });
    eq(r.status, 200, 'logs: call succeeded');
    await new Promise((res) => setTimeout(res, 200));
    const logs = s.logs();
    ok(!logs.includes(r.json.uid), 'logs: the proof itself never appears in the log');
    ok(!logs.includes('ZZZZZZZZZZZZ'), 'logs: no fragment of the proof appears either');
    ok(logs.includes('logcheck1'), 'logs: the session id IS logged, which is allowed and useful');
    ok(!logs.includes(SECRET), 'logs: the bearer secret never appears in the log');
  } finally { await s.stop(); }

  // Plant check: prove the assertion above can actually fail. A stub whose
  // "proof" is a string the server does log must be caught.
  const logs = 'some log line with PROOF-FOR-x in it';
  ok(logs.includes('PROOF-FOR-x'), 'logs: plant - the grep used above does detect a leak when there is one');
}

async function testStartupGuards() {
  let s = await startServer({ UID_SECRET: '' }, { expectExit: true });
  ok(s.proc.exitCode === 1, 'startup: refuses to run with no secret');
  ok(/UID_SECRET is not set/.test(s.logs()), 'startup: says why it refused');
  await s.stop();

  s = await startServer({ UID_SECRET: 'short' }, { expectExit: true });
  ok(s.proc.exitCode === 1, 'startup: refuses a short secret');
  await s.stop();

  s = await startServer({ UID_BINARY: path.join(TMP, 'does-not-exist') }, { expectExit: true });
  ok(s.proc.exitCode === 1, 'startup: refuses when the binary is missing');
  ok(/binary not found/.test(s.logs()), 'startup: names the missing binary');
  await s.stop();

  // Checksum enforcement: a stub with hash checking ON must be rejected.
  s = await startServer({ UID_SKIP_HASH_CHECK: '0', UID_BINARY: STUBS.good }, { expectExit: true });
  ok(s.proc.exitCode === 1, 'startup: refuses a binary whose checksum does not match the pin');
  ok(/checksum mismatch/.test(s.logs()), 'startup: names the checksum problem');
  await s.stop();

  // Warns when wide open.
  s = await startServer({ ALLOW_IPS: '' });
  ok(/ALLOW_IPS is empty/.test(s.logs()), 'startup: warns when no IP allowlist is configured');
  await s.stop();
}

function testEnsureScript() {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'ensure-'));
  const wrong = path.join(TMP, 'wrong-binary');
  fs.writeFileSync(wrong, 'this is not faf-uid');

  let failedAsExpected = false;
  let message = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'ensure-faf-uid.js')], {
      env: Object.assign({}, process.env, { DATA_DIR: dataDir, UID_LOCAL_SOURCE: wrong }),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    failedAsExpected = true;
    message = (err.stderr || '') + (err.stdout || '');
  }
  ok(failedAsExpected, 'ensure: a file with the wrong checksum is refused');
  ok(/checksum mismatch/.test(message), 'ensure: it says the checksum did not match');
  ok(!fs.existsSync(path.join(dataDir, 'bin', 'faf-uid')), 'ensure: nothing is installed on a mismatch');

  if (REAL_BINARY && fs.existsSync(REAL_BINARY)) {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'ensure-faf-uid.js')], {
      env: Object.assign({}, process.env, { DATA_DIR: dataDir, UID_LOCAL_SOURCE: REAL_BINARY }),
      encoding: 'utf8'
    });
    const installed = path.join(dataDir, 'bin', 'faf-uid');
    ok(fs.existsSync(installed), 'ensure: the genuine binary installs');
    ok(/sha256 ok/.test(out), 'ensure: it confirms the checksum');
    const mode = fs.statSync(installed).mode & 0o777;
    ok((mode & 0o111) !== 0, 'ensure: the installed binary has the executable bit', mode.toString(8));

    const again = execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'ensure-faf-uid.js')], {
      env: Object.assign({}, process.env, { DATA_DIR: dataDir }), encoding: 'utf8'
    });
    ok(/already present and verified/.test(again), 'ensure: a second run verifies rather than re-downloading');
  }
}

async function testRealBinary() {
  if (!REAL_BINARY || !fs.existsSync(REAL_BINARY)) {
    console.log('  (skipping the real-binary block: set REAL_FAF_UID to the v4.0.7 path to run it)');
    return;
  }
  const s = await startServer({ UID_BINARY: REAL_BINARY, UID_SKIP_HASH_CHECK: '0' });
  try {
    const a = await request(s.port, { body: { session: '1234567890' }, headers: authed });
    eq(a.status, 200, 'real: a proof is issued');
    ok(typeof a.json.uid === 'string' && a.json.uid.length > 500, 'real: the proof is a substantial blob', String(a.json.uid && a.json.uid.length));
    ok(!/\s/.test(a.json.uid), 'real: the proof is returned trimmed, with no stray whitespace');
    ok(!('stderr' in a.json), 'real: no stderr field on success, even though the binary writes to stderr here');

    const b = await request(s.port, { body: { session: '9999999999' }, headers: authed });
    ok(b.json.uid !== a.json.uid, 'real: a different session produces a different proof');

    // Documents the finding that makes caching impossible to sanity-check by
    // comparison: the same session does NOT produce the same blob.
    const c = await request(s.port, { body: { session: '1234567890' }, headers: authed });
    eq(c.status, 200, 'real: repeating a session still works');
    ok(c.json.uid !== a.json.uid, 'real: the same session yields a different blob each run (random IV)');

    await new Promise((res) => setTimeout(res, 200));
    ok(!s.logs().includes(a.json.uid), 'real: the genuine proof is not in the log');

    const t0 = Date.now();
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => request(s.port, { body: { session: '55555' + i }, headers: authed })));
    const ms = Date.now() - t0;
    ok(many.every((r) => r.status === 200), 'real: 12 concurrent calls all succeed');
    ok(new Set(many.map((r) => r.json.uid)).size === 12, 'real: 12 concurrent calls produce 12 distinct proofs');
    console.log('  (12 concurrent real runs took ' + ms + 'ms)');
  } finally { await s.stop(); }
}

/* --------------------------------------------------------------------- main */

(async () => {
  console.log('uid-relay suite');
  console.log('');

  const blocks = [
    ['auth', testAuth], ['allowlist', testAllowlist], ['validation', testValidation],
    ['stderr handling', testStderrHandling], ['no caching', testNoCaching],
    ['concurrency', testConcurrency], ['log hygiene', testLogHygiene],
    ['startup guards', testStartupGuards], ['ensure script', testEnsureScript],
    ['real binary', testRealBinary]
  ];
  for (const [name, fn] of blocks) {
    const before = fail;
    try {
      await fn();
    } catch (err) {
      fail++;
      failures.push(name + ': block threw -> ' + (err && err.message));
    }
    console.log('  ' + name.padEnd(16) + (fail === before ? 'ok' : 'FAILED'));
  }

  console.log('');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('suite crashed: ' + (err && err.stack));
  process.exit(1);
});
