'use strict';

/**
 * Runs the faf-uid binary. One process per request, never cached.
 *
 * Two things in here are not obvious and are the reason this file exists:
 *
 *  1. faf-uid writes to stderr even when it SUCCEEDS. On a headless server it
 *     reports "xrandr: not found" and "lspci: not found" every single run and
 *     still exits 0 with a perfectly good proof on stdout. So stderr is not a
 *     failure signal. Exit code is. Treating stderr as failure would break the
 *     service permanently on any host without X and pciutils, which is every
 *     server.
 *
 *  2. The environment handed to the child is PINNED. faf-uid shells out to
 *     `lsblk`, `lspci`, `xrandr`, `uname` and resolves them through PATH, and
 *     what it finds goes into the machine fingerprint. If PATH drifts, the
 *     fingerprint drifts, and to FAF that reads as a different machine. A fixed
 *     env costs nothing and removes a whole class of silent drift.
 */

const { spawn } = require('child_process');

// Deliberately fixed. See note 2 above. Do not inherit process.env here.
const CHILD_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const STDOUT_CAP = 256 * 1024; // a proof is ~1.9 KB; this is a runaway guard
const STDERR_CAP = 8 * 1024;

class UidError extends Error {
  constructor(message, { stderr = '', code = null, signal = null, kind = 'failed' } = {}) {
    super(message);
    this.name = 'UidError';
    this.stderr = stderr;
    this.exitCode = code;
    this.signal = signal;
    this.kind = kind; // 'failed' | 'timeout' | 'spawn' | 'empty'
  }
}

/**
 * The session id is passed as a single plain argument with no shell involved
 * (spawn with an argv array), so this validation is hygiene rather than the
 * thing standing between us and injection. It is kept permissive on purpose:
 * FAF issues numeric session ids today, but rejecting anything non-numeric
 * would turn a future format change into an outage on our side.
 */
function validateSession(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return { ok: false, reason: 'session must be a string' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'session must not be empty' };
  if (s.length > 64) return { ok: false, reason: 'session must be at most 64 characters' };
  if (!/^[A-Za-z0-9_.:-]+$/.test(s)) return { ok: false, reason: 'session contains unsupported characters' };
  return { ok: true, session: s };
}

function runUid(binary, session, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000;
  const cwd = opts.cwd || '/tmp';

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, [session], {
        cwd,
        env: { PATH: CHILD_PATH, HOME: cwd, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so a timeout can kill the whole tree. faf-uid
        // shells out to lsblk/lspci/xrandr; killing only the parent leaves
        // those grandchildren alive, still holding the stdout pipe open, and
        // 'close' then never fires. The suite caught exactly this: a 700 ms
        // timeout took 5 s to answer.
        detached: true
      });
    } catch (err) {
      reject(new UidError('could not start faf-uid: ' + err.message, { kind: 'spawn' }));
      return;
    }

    let out = '';
    let err = '';
    let outTrunc = false;
    let errTrunc = false;
    let settled = false;
    let timedOut = false;

    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
        try { child.kill('SIGKILL'); } catch (_2) { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Settle now rather than waiting for 'close'. A grandchild that survives
      // the kill would otherwise hold this request open past its own timeout,
      // which is the one thing a timeout exists to prevent.
      finish(reject, new UidError('faf-uid timed out after ' + timeoutMs + ' ms', {
        stderr: err, kind: 'timeout'
      }));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (out.length >= STDOUT_CAP) { outTrunc = true; return; }
      out += d.toString('utf8');
      if (out.length > STDOUT_CAP) { out = out.slice(0, STDOUT_CAP); outTrunc = true; }
    });
    child.stderr.on('data', (d) => {
      if (err.length >= STDERR_CAP) { errTrunc = true; return; }
      err += d.toString('utf8');
      if (err.length > STDERR_CAP) { err = err.slice(0, STDERR_CAP); errTrunc = true; }
    });

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    child.on('error', (e) => {
      finish(reject, new UidError('could not start faf-uid: ' + e.message, { kind: 'spawn', stderr: err }));
    });

    child.on('close', (code, signal) => {
      const stderr = errTrunc ? err + '\n[stderr truncated]' : err;

      if (timedOut) {
        finish(reject, new UidError('faf-uid timed out after ' + timeoutMs + ' ms', { stderr, kind: 'timeout', signal }));
        return;
      }
      if (code !== 0) {
        finish(reject, new UidError('faf-uid exited with code ' + code, { stderr, code, signal, kind: 'failed' }));
        return;
      }

      const uid = out.trim();
      if (!uid) {
        // Exit 0 and nothing on stdout. Never seen in practice, but if it ever
        // happens, returning "" as a proof would reach the lobby server as a
        // credential and come back as a bare {"command":"invalid"}.
        finish(reject, new UidError('faf-uid produced no output', { stderr, code, kind: 'empty' }));
        return;
      }
      if (outTrunc) {
        finish(reject, new UidError('faf-uid output exceeded ' + STDOUT_CAP + ' bytes', { stderr, code, kind: 'failed' }));
        return;
      }

      // stderr is intentionally NOT passed along on success. See note 1.
      finish(resolve, { uid });
    });
  });
}

/**
 * Bounded concurrency. Requests run in parallel up to `max`; beyond that they
 * wait briefly, and beyond `maxQueue` they are refused with 503 rather than
 * queued into a login timeout. Serialising these behind one lock is the
 * documented way to turn a fast service into a broken one.
 */
function createLimiter(max, maxQueue, queueWaitMs) {
  let active = 0;
  const waiting = [];

  function next() {
    if (!waiting.length || active >= max) return;
    const item = waiting.shift();
    clearTimeout(item.timer);
    active++;
    item.resolve(release);
  }

  function release() {
    active--;
    next();
  }

  function acquire() {
    return new Promise((resolve, reject) => {
      if (active < max) { active++; resolve(release); return; }
      if (waiting.length >= maxQueue) {
        const e = new Error('service busy');
        e.busy = true;
        reject(e);
        return;
      }
      const item = { resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        const i = waiting.indexOf(item);
        if (i >= 0) waiting.splice(i, 1);
        const e = new Error('timed out waiting for a slot');
        e.busy = true;
        reject(e);
      }, queueWaitMs);
      waiting.push(item);
    });
  }

  return {
    acquire,
    stats: () => ({ active, queued: waiting.length, max, maxQueue })
  };
}

module.exports = { runUid, validateSession, createLimiter, UidError, CHILD_PATH };
