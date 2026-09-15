'use strict';

/**
 * Bearer secret + optional IP allowlist.
 *
 * The allowlist is the part that is easy to get wrong behind a reverse proxy.
 * Nginx Proxy Manager terminates the connection, so req.socket.remoteAddress is
 * always the proxy and an allowlist checked against it would allow everything.
 * The fix is X-Forwarded-For - but blindly trusting X-Forwarded-For is worse
 * than having no allowlist at all, because anyone on the internet can then set
 * it to an allowed value and walk straight through.
 *
 * So: X-Forwarded-For is consulted only when the direct peer is itself in
 * TRUST_PROXY, and we walk the header from the right, discarding hops that are
 * themselves trusted. The first untrusted address is the real client.
 */

const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // Hash first so differing lengths do not throw and do not leak length.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkBearer(req, secret) {
  const h = req.headers['authorization'];
  if (!h || typeof h !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  return timingSafeEqualStr(m[1].trim(), secret);
}

function normaliseIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  // ::ffff:1.2.3.4 -> 1.2.3.4
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) return m[1];
  return s.toLowerCase();
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

/** Supports "1.2.3.4", "10.0.0.0/8", and exact IPv6 literals. */
function parseRule(rule) {
  const r = normaliseIp(rule);
  if (!r) return null;
  const slash = r.indexOf('/');
  if (slash === -1) {
    const v4 = ipv4ToInt(r);
    if (v4 !== null) return { kind: 'v4', base: v4, bits: 32 };
    return { kind: 'exact', value: r };
  }
  const addr = r.slice(0, slash);
  const bits = Number(r.slice(slash + 1));
  const v4 = ipv4ToInt(addr);
  if (v4 === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return { kind: 'exact', value: r };
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { kind: 'v4', base: (v4 & mask) >>> 0, bits, mask };
}

function parseList(str) {
  if (!str) return [];
  return String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseRule)
    .filter(Boolean);
}

function ipMatches(ip, rules) {
  const norm = normaliseIp(ip);
  if (!norm || !rules.length) return false;
  const v4 = ipv4ToInt(norm);
  for (const rule of rules) {
    if (rule.kind === 'exact') {
      if (rule.value === norm) return true;
    } else if (rule.kind === 'v4' && v4 !== null) {
      const mask = rule.bits === 32 ? 0xffffffff : (rule.mask === undefined ? 0xffffffff : rule.mask);
      if (((v4 & mask) >>> 0) === rule.base) return true;
    }
  }
  return false;
}

/**
 * Resolve the client address. `trustRules` is the set of proxies whose
 * X-Forwarded-For we are willing to believe.
 */
function clientIp(req, trustRules) {
  const peer = normaliseIp(req.socket && req.socket.remoteAddress);
  if (!trustRules.length || !ipMatches(peer, trustRules)) return peer;

  const xff = req.headers['x-forwarded-for'];
  if (!xff) return peer;
  const hops = String(xff).split(',').map(normaliseIp).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!ipMatches(hops[i], trustRules)) return hops[i];
  }
  // Every hop was a trusted proxy; the peer is the best we have.
  return peer;
}

module.exports = { checkBearer, timingSafeEqualStr, parseList, ipMatches, clientIp, normaliseIp };
