'use strict';

/**
 * Auto-update: watch the git remote and restart when it moves.
 *
 * HOW THE RESTART WORKS, because it looks like a trick.
 * The container's command clones the repo and then execs the server. Docker's
 * `restart: unless-stopped` restarts the container on ANY exit, including exit
 * 0. So to deploy a new version this process simply exits, and Docker re-runs
 * the command, which re-clones. No docker socket, no privileged access, no
 * inbound endpoint, nothing to expose. The container's own lifecycle is the
 * deploy mechanism.
 *
 * WHY POLLING RATHER THAN A WEBHOOK.
 * A webhook is instant, but it means a public endpoint, a shared secret, an
 * NPM route and signature verification. Polling `git ls-remote` is one cheap
 * network call a minute, needs no inbound exposure at all, and works the same
 * for a private repo because it reuses the credentials already in the clone
 * URL. For a site where a minute's delay does not matter, that is a better
 * trade.
 *
 * THE SAFETY CHECK IS THE POINT.
 * The whole reason for this feature is to let someone with only GitHub access
 * update the site. That is exactly the situation where a broken commit reaches
 * production with nobody watching. So a detected change is NOT deployed
 * blindly: the new revision is cloned to a temp directory, syntax-checked, and
 * put through the test suite. Only if that passes does this process exit. A bad
 * commit is logged loudly and the old version keeps serving.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  intervalMs: 60_000,
  branch: 'main',
  appDir: '/app',
  verifyTimeoutMs: 120_000
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeoutMs || 60_000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env || process.env
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/** Strip any embedded credentials before a URL goes anywhere near a log. */
function redactUrl(url) {
  return String(url).replace(/\/\/[^@/]*@/, '//***@');
}

function createWatcher(config = {}) {
  const cfg = Object.assign({}, DEFAULTS, config);
  const exec = cfg.exec || run;          // injectable for tests
  const log = cfg.log || (() => {});
  const onDeploy = cfg.onDeploy || (() => process.exit(0));

  let timer = null;
  let busy = false;
  let lastSeenRemote = null;   // remote sha we already judged
  let lastResult = 'idle';
  let currentSha = null;

  async function localSha() {
    return exec('git', ['-C', cfg.appDir, 'rev-parse', 'HEAD']);
  }

  async function remoteSha() {
    const out = await exec('git', ['-C', cfg.appDir, 'ls-remote', 'origin', cfg.branch]);
    const first = out.split('\n')[0] || '';
    const sha = first.split(/\s+/)[0] || '';
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }

  /**
   * Clone the candidate revision somewhere temporary and prove it runs before
   * letting it near production.
   */
  async function verify(sha) {
    const originUrl = await exec('git', ['-C', cfg.appDir, 'remote', 'get-url', 'origin']);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faf-web-verify-'));
    try {
      await exec('git', ['clone', '--depth', '1', '--branch', cfg.branch, originUrl, tmp],
        { timeoutMs: cfg.verifyTimeoutMs });

      const files = ['server.js', 'lib/proxy.js', 'lib/static.js', 'lib/upstreams.js',
        'lib/watcher.js', 'public/app.js', 'webtest.js'];
      for (const f of files) {
        if (!fs.existsSync(path.join(tmp, f))) {
          return { ok: false, reason: 'missing file: ' + f };
        }
        await exec(process.execPath, ['--check', path.join(tmp, f)], { timeoutMs: 20_000 });
      }

      // The suite needs no network and takes a couple of seconds.
      await exec(process.execPath, [path.join(tmp, 'webtest.js')],
        { cwd: tmp, timeoutMs: cfg.verifyTimeoutMs });

      return { ok: true };
    } catch (err) {
      const detail = (err.stderr || err.stdout || err.message || '').split('\n').slice(-6).join(' ').trim();
      return { ok: false, reason: detail.slice(0, 400) || 'verification failed' };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const local = await localSha();
      currentSha = local;
      const remote = await remoteSha();

      if (!remote) { lastResult = 'could not read remote'; return; }
      if (remote === local) { lastResult = 'up to date'; return; }

      // Judge each revision once. Without this, a broken commit would be
      // re-cloned and re-tested every single interval until someone fixed it.
      if (remote === lastSeenRemote) { lastResult = 'holding: newest revision failed verification'; return; }
      lastSeenRemote = remote;

      log('info', 'update detected, verifying before deploy', {
        from: local.slice(0, 8), to: remote.slice(0, 8), branch: cfg.branch
      });

      const result = await verify(remote);
      if (!result.ok) {
        lastResult = 'rejected ' + remote.slice(0, 8);
        log('error', 'UPDATE REJECTED - the new revision did not pass verification, still serving the old one', {
          sha: remote.slice(0, 8), reason: result.reason
        });
        return;
      }

      lastResult = 'deploying ' + remote.slice(0, 8);
      log('info', 'update verified, restarting to deploy it', {
        from: local.slice(0, 8), to: remote.slice(0, 8)
      });
      onDeploy();
    } catch (err) {
      lastResult = 'error';
      log('warn', 'update check failed', { reason: (err && err.message || '').slice(0, 200) });
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, cfg.intervalMs);
      timer.unref();
      // One check shortly after boot, not immediately, so a restart loop caused
      // by something else does not hammer the remote.
      setTimeout(() => { tick().catch(() => {}); }, 15_000).unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    status: () => ({
      enabled: true,
      branch: cfg.branch,
      intervalMs: cfg.intervalMs,
      currentSha: currentSha ? currentSha.slice(0, 8) : null,
      last: lastResult
    })
  };
}

module.exports = { createWatcher, redactUrl };
