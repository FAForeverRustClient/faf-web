'use strict';

/**
 * uid-relay
 *
 *   POST /uid          Authorization: Bearer <secret>   {"session":"1234567890"}
 *     200 {"uid":"<stdout of faf-uid, trimmed>"}
 *     4xx/5xx {"error":"...","stderr":"<faf-uid's own complaint, verbatim>"}
 *
 *   GET  /health       no auth. Liveness only, says nothing about the machine.
 *   GET  /fingerprint  Authorization: Bearer <secret>. Drift report, see lib/fingerprint.js.
 *
 * Rules this file exists to keep:
 *   - every call runs the binary; nothing is ever cached
 *   - stderr goes in the error body and NEVER in the success field
 *   - proofs are never written to the log
 *   - calls run in parallel, not behind one lock
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { runUid, validateSession, createLimiter, UidError } = require('./lib/uid');
const auth = require('./lib/auth');
const fingerprint = require('./lib/fingerprint');
const release = require('./lib/release');

const PORT = Number(process.env.PORT || 8097);
const DATA_DIR = process.env.DATA_DIR || '/data';
const BINARY = process.env.UID_BINARY || path.join(DATA_DIR, 'bin', 'faf-uid');
const RUN_DIR = process.env.UID_RUN_DIR || path.join(DATA_DIR, 'run');
const SECRET = process.env.UID_SECRET || '';
const ALLOW_RULES = auth.parseList(process.env.ALLOW_IPS || '');
const TRUST_RULES = auth.parseList(process.env.TRUST_PROXY || '');
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 16);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 64);
const QUEUE_WAIT_MS = Number(process.env.QUEUE_WAIT_MS || 10000);
const UID_TIMEOUT_MS = Number(process.env.UID_TIMEOUT_MS || 25000);
const SKIP_HASH_CHECK = process.env.UID_SKIP_HASH_CHECK === '1';
const MAX_BODY = 4096;

const limiter = createLimiter(MAX_CONCURRENCY, MAX_QUEUE, QUEUE_WAIT_MS);
const started = Date.now();
let fingerprintState = null;

/* ------------------------------------------------------------------ logging */

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg };
  if (extra) Object.assign(line, extra);
  // Proofs are credentials. Nothing that carries one is ever passed in here;
  // uidtest.js asserts that by grepping a real run's output for the blob.
  process.stdout.write(JSON.stringify(line) + '\n');
}

/* ------------------------------------------------------------------- helpers */

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        // Do not destroy the socket here: the 413 still has to get out. Stop
        // reading, answer, and let the response close the connection.
        req.pause();
        reject(Object.assign(new Error('body too large'), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorise(req, res, ip) {
  if (ALLOW_RULES.length && !auth.ipMatches(ip, ALLOW_RULES)) {
    send(res, 403, { error: 'address not allowed' });
    return false;
  }
  if (!auth.checkBearer(req, SECRET)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    send(res, 401, { error: 'bad or missing bearer token' });
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------- routes */

async function handleUid(req, res, ip) {
  const t0 = Date.now();

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (err) {
    if (err.tooLarge) {
      res.setHeader('Connection', 'close');
      send(res, 413, { error: 'request body too large' });
      return;
    }
    send(res, 400, { error: 'could not read request body' });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (_) {
    send(res, 400, { error: 'body must be JSON' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, 400, { error: 'body must be a JSON object' });
    return;
  }

  const v = validateSession(body.session);
  if (!v.ok) { send(res, 400, { error: v.reason }); return; }
  const session = v.session;

  let release_;
  try {
    release_ = await limiter.acquire();
  } catch (err) {
    log('warn', 'refused, at capacity', { session, ip, ...limiter.stats() });
    res.setHeader('Retry-After', '2');
    send(res, 503, { error: 'service busy, try again', stderr: '' });
    return;
  }

  try {
    const { uid } = await runUid(BINARY, session, { timeoutMs: UID_TIMEOUT_MS, cwd: RUN_DIR });
    // uid deliberately absent from the log line.
    log('info', 'uid issued', { session, ip, ms: Date.now() - t0, bytes: uid.length });
    send(res, 200, { uid });
  } catch (err) {
    const stderr = err instanceof UidError ? err.stderr : '';
    const kind = err instanceof UidError ? err.kind : 'failed';
    const status = kind === 'timeout' ? 504 : (kind === 'spawn' ? 500 : 502);
    log('error', 'uid failed', {
      session, ip, ms: Date.now() - t0, kind,
      exitCode: err.exitCode === undefined ? null : err.exitCode,
      reason: err.message,
      stderr: stderr.slice(0, 500)
    });
    // stderr goes here and only here. Never in a success field.
    send(res, status, { error: err.message, stderr });
  } finally {
    release_();
  }
}

function handleHealth(req, res) {
  // Unauthenticated on purpose so a monitor can watch it. It says nothing about
  // the machine, the fingerprint, or whether a secret is configured correctly.
  send(res, 200, {
    ok: true,
    service: 'uid-relay',
    uidVersion: release.VERSION,
    uptimeSeconds: Math.floor((Date.now() - started) / 1000),
    ...limiter.stats()
  });
}

function handleFingerprint(req, res) {
  const fresh = fingerprint.collect();
  send(res, 200, {
    digest: fresh.digest,
    digestAtStartup: fingerprintState ? fingerprintState.digest : null,
    previousStartupDigest: fingerprintState ? fingerprintState.previous : null,
    changedAtLastStartup: fingerprintState ? fingerprintState.changed : null,
    movedFields: fingerprintState ? fingerprintState.movedFields : [],
    note: 'This digest is local to this service. It is NOT FAF\'s uid_hash and means nothing to FAF.',
    fields: fresh.fields
  });
}

/* --------------------------------------------------------------------- serve */

const server = http.createServer((req, res) => {
  const ip = auth.clientIp(req, TRUST_RULES);
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    handleHealth(req, res);
    return;
  }
  if (req.method === 'GET' && url === '/fingerprint') {
    if (!authorise(req, res, ip)) return;
    handleFingerprint(req, res);
    return;
  }
  if (url === '/uid') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      send(res, 405, { error: 'use POST' });
      return;
    }
    if (!authorise(req, res, ip)) return;
    handleUid(req, res, ip).catch((err) => {
      log('error', 'unhandled', { reason: err && err.message });
      if (!res.headersSent) send(res, 500, { error: 'internal error', stderr: '' });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

// Must sit above UID_TIMEOUT_MS or node cuts the connection before faf-uid is done.
server.requestTimeout = UID_TIMEOUT_MS + 15000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 65000;

/* ------------------------------------------------------------------- startup */

function fail(msg) {
  log('fatal', msg);
  process.exit(1);
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

async function startup() {
  if (!SECRET) fail('UID_SECRET is not set. Refusing to start: an unauthenticated uid service mints lobby-valid machine proofs carrying this host\'s identity.');
  if (SECRET.length < 24) fail('UID_SECRET is shorter than 24 characters. Refusing to start.');

  if (!fs.existsSync(BINARY)) fail('faf-uid binary not found at ' + BINARY + '. Run: node scripts/ensure-faf-uid.js');
  try {
    fs.accessSync(BINARY, fs.constants.X_OK);
  } catch (_) {
    fail('faf-uid at ' + BINARY + ' is not executable.');
  }

  if (!SKIP_HASH_CHECK) {
    const got = sha256File(BINARY);
    if (got !== release.SHA256) {
      fail('faf-uid checksum mismatch. Expected ' + release.SHA256 + ', got ' + got + '. Refusing to start.');
    }
  }

  try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch (_) { /* best effort */ }

  fingerprintState = fingerprint.checkAndRecord(path.join(DATA_DIR, 'fingerprint.json'));
  if (fingerprintState.changed) {
    log('warn', 'MACHINE FINGERPRINT MOVED SINCE LAST START - FAF will see this as a different machine', {
      previous: fingerprintState.previous,
      now: fingerprintState.digest,
      movedFields: fingerprintState.movedFields
    });
  } else {
    log('info', 'machine fingerprint', {
      digest: fingerprintState.digest,
      firstRun: fingerprintState.previous === null
    });
  }

  // Prove the binary actually runs on this host now, rather than finding out
  // when the first player opens the Play tab.
  const t0 = Date.now();
  try {
    await runUid(BINARY, 'startupselftest', { timeoutMs: UID_TIMEOUT_MS, cwd: RUN_DIR });
    log('info', 'self test ok', { ms: Date.now() - t0 });
  } catch (err) {
    log('error', 'SELF TEST FAILED - the service is up but faf-uid does not work here', {
      reason: err.message,
      stderr: (err.stderr || '').slice(0, 500)
    });
  }

  server.listen(PORT, () => {
    log('info', 'listening', {
      port: PORT,
      uidVersion: release.VERSION,
      binary: BINARY,
      maxConcurrency: MAX_CONCURRENCY,
      uidTimeoutMs: UID_TIMEOUT_MS,
      ipAllowlist: ALLOW_RULES.length ? 'on' : 'OFF',
      trustedProxies: TRUST_RULES.length
    });
    if (!ALLOW_RULES.length) {
      log('warn', 'ALLOW_IPS is empty - the bearer secret is the only thing standing between the internet and this service');
    }
  });
}

function shutdown(sig) {
  log('info', 'shutting down', { signal: sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startup().catch((err) => fail('startup failed: ' + (err && err.message)));
}

module.exports = { server, startup };
