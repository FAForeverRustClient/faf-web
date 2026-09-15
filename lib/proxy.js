'use strict';

/**
 * Read-only fetching proxy with a small in-memory cache.
 *
 * Deliberate properties:
 *  - GET only. Nothing here can change anything upstream.
 *  - No credentials are ever forwarded. The browser's cookies and Authorization
 *    header are dropped, so this cannot be tricked into acting as a logged-in
 *    user, and FAF never sees a request it could mistake for an authenticated
 *    one. Every tab in this build reads public data.
 *  - Response size and time are capped, so one slow or enormous upstream cannot
 *    hold the whole service open.
 *  - Failures are reported as our own status with a short message. Upstream
 *    error bodies are passed through only for JSON, because they are useful and
 *    small; HTML error pages are not forwarded.
 */

const https = require('https');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 500;

/** Tiny LRU-ish cache. Bounded so a hostile query string cannot grow it forever. */
function createCache(maxEntries = MAX_CACHE_ENTRIES) {
  const map = new Map();

  function get(key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) { map.delete(key); return null; }
    // Refresh recency.
    map.delete(key);
    map.set(key, hit);
    return hit;
  }

  function set(key, value, ttlMs) {
    if (map.size >= maxEntries) {
      // Oldest insertion first.
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { ...value, expires: Date.now() + ttlMs });
  }

  return { get, set, size: () => map.size, clear: () => map.clear() };
}

/**
 * The complete set of headers sent upstream. Nothing from the incoming browser
 * request is ever copied in here, which is what keeps this from being usable as
 * an authenticated relay.
 *
 * It is a module-level constant rather than an inline literal so the suite can
 * assert on the real thing. An earlier version of the test inspected the stub's
 * arguments instead, which meant planting an Authorization header here went
 * undetected - a false pass that proved nothing.
 */
const UPSTREAM_HEADERS = Object.freeze({
  'User-Agent': 'faf-web',
  Accept: 'application/json, text/plain;q=0.8, */*;q=0.5'
});

function fetchUpstream(url, { timeoutMs = TIMEOUT_MS, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: UPSTREAM_HEADERS
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          reject(Object.assign(new Error('upstream response too large'), { tooLarge: true }));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        contentType: res.headers['content-type'] || 'application/octet-stream',
        body: Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('upstream timed out'), { timeout: true }));
    });
    req.on('error', reject);
  });
}

/**
 * @returns {Promise<{status:number, contentType:string, body:Buffer, cached:boolean}>}
 */
async function proxyGet(target, cache, opts = {}) {
  const cached = cache.get(target.url);
  if (cached) return { ...cached, cached: true };

  // `fetchImpl` exists so the suite can drive every branch (slow upstream,
  // oversized body, 500s, header hygiene) without a network. Production never
  // passes it.
  const doFetch = opts.fetchImpl || fetchUpstream;

  let res;
  try {
    res = await doFetch(target.url, opts);
  } catch (err) {
    const status = err.timeout ? 504 : (err.tooLarge ? 502 : 502);
    return {
      status,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ error: 'upstream unreachable: ' + err.message })),
      cached: false
    };
  }

  const isJson = /json/i.test(res.contentType);

  if (res.status < 200 || res.status >= 300) {
    return {
      status: res.status,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({
        error: 'upstream returned ' + res.status,
        // Upstream JSON errors are small and say something useful. An HTML
        // error page is noise and is not forwarded.
        detail: isJson ? safeJson(res.body) : undefined
      })),
      cached: false
    };
  }

  const value = { status: res.status, contentType: res.contentType, body: res.body };
  // Only successful responses are cached. A blip must not be pinned for a minute.
  cache.set(target.url, value, target.ttlMs);
  return { ...value, cached: false };
}

function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return undefined; }
}

module.exports = { createCache, proxyGet, fetchUpstream, UPSTREAM_HEADERS, MAX_BYTES };
