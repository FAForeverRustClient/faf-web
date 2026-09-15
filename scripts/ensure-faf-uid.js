'use strict';

/**
 * Fetches the pinned faf-uid release into DATA_DIR/bin and verifies it.
 *
 * The binary is NOT committed to this repo. It is a 3.7 MB release asset that
 * belongs to FAForever, and keeping it out of git means the thing we run is the
 * official artefact rather than a copy somebody re-uploaded at some point.
 *
 * It lands in the data volume, so a container restart does not re-download it,
 * but the checksum is re-verified on every start regardless. Verification is
 * the point; caching is just a courtesy to GitHub.
 *
 * Fails closed. If the checksum does not match, nothing is installed.
 *
 *   node scripts/ensure-faf-uid.js
 *
 * Env:
 *   DATA_DIR          where bin/faf-uid goes (default /data)
 *   UID_LOCAL_SOURCE  copy from this path instead of downloading, for a host
 *                     with no route to github. Still checksum-verified.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const release = require('../lib/release');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BIN_DIR = path.join(DATA_DIR, 'bin');
const TARGET = path.join(BIN_DIR, 'faf-uid');
const MAX_REDIRECTS = 6;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function say(msg) {
  process.stdout.write('[ensure-faf-uid] ' + msg + '\n');
}

function download(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('too many redirects')); return; }
    https.get(url, { headers: { 'User-Agent': 'uid-relay' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(download(next, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error('HTTP ' + status + ' fetching ' + url));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024 * 1024) {
          res.destroy();
          reject(new Error('response far larger than the expected ' + release.SIZE + ' bytes'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function install(buf) {
  const got = sha256(buf);
  if (got !== release.SHA256) {
    throw new Error(
      'checksum mismatch, refusing to install.\n' +
      '  expected ' + release.SHA256 + '\n' +
      '  got      ' + got + '\n' +
      'This is either a corrupt transfer or not the official ' + release.VERSION + ' asset.'
    );
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(BIN_DIR, '.faf-uid.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, TARGET);
  fs.chmodSync(TARGET, 0o755);
  say('installed ' + release.VERSION + ' at ' + TARGET + ' (' + buf.length + ' bytes, sha256 ok)');
}

async function main() {
  if (fs.existsSync(TARGET)) {
    const existing = fs.readFileSync(TARGET);
    if (sha256(existing) === release.SHA256) {
      try { fs.chmodSync(TARGET, 0o755); } catch (_) { /* read-only volume, fine if already +x */ }
      say(release.VERSION + ' already present and verified at ' + TARGET);
      return;
    }
    say('existing binary does not match the pinned checksum, replacing it');
  }

  const local = process.env.UID_LOCAL_SOURCE;
  if (local) {
    say('copying from ' + local);
    install(fs.readFileSync(local));
    return;
  }

  say('downloading ' + release.URL);
  install(await download(release.URL, MAX_REDIRECTS));
}

main().catch((err) => {
  process.stderr.write('[ensure-faf-uid] FAILED: ' + err.message + '\n');
  process.exit(1);
});
