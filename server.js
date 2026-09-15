'use strict';

/**
 * faf-web - the FAF mobile web client.
 *
 * One process does two jobs:
 *   1. serves the app out of public/
 *   2. proxies the read-only upstream APIs under /api/
 *
 * Job 2 exists so the browser only ever talks to this origin. That removes the
 * CORS question entirely: it does not matter whether api.faforever.com allows
 * browser origins, because no browser ever calls it directly. It also means
 * tournaments.doodlepros.com does not need CORS headers added, which would
 * otherwise have been a change to a second codebase.
 *
 * There is no Play tab and no lobby code. That is deliberate and is the reason
 * this service needs no secrets, no database and no authentication: every tab
 * in this build reads public data.
 *
 * Zero runtime dependencies, no build step. Upload the files, restart the
 * container.
 */

const http = require('http');
const path = require('path');

const { resolve: resolveUpstream } = require('./lib/upstreams');
const { createCache, proxyGet } = require('./lib/proxy');
const { resolveFile, cacheHeader } = require('./lib/static');

const PORT = Number(process.env.PORT || 8098);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const started = Date.now();
const cache = createCache();

/* ------------------------------------------------------------------ logging */

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg };
  if (extra) Object.assign(line, extra);
  process.stdout.write(JSON.stringify(line) + '\n');
}

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The app embeds three upstream pages (news, changelog, unit db) in
    // iframes, so frame-src has to name them. Everything else is same-origin.
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' https://content.faforever.com data:",
      "frame-src https://www.faforever.com https://faforever.github.io https://www.youtube-nocookie.com",
      "connect-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')
  };
}

/* ------------------------------------------------------------------- routing */

async function handleApi(req, res, url) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'this API is read-only' });
    return;
  }

  // /api/<route>/<rest...>
  const parts = url.pathname.split('/').filter(Boolean); // ['api', route, ...rest]
  const routeName = parts[1];
  const rest = parts.slice(2).join('/');

  const target = resolveUpstream(routeName, rest, url.search);
  if (!target) {
    // Deliberately identical answer for "unknown route" and "blocked resource",
    // so this cannot be used to enumerate what is reachable.
    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }

  const t0 = Date.now();
  const out = await proxyGet(target, cache);
  log(out.status >= 400 ? 'warn' : 'info', 'proxy', {
    route: routeName, rest, status: out.status,
    ms: Date.now() - t0, cached: out.cached, bytes: out.body.length
  });

  res.writeHead(out.status, Object.assign({
    'Content-Type': out.contentType,
    'Content-Length': out.body.length,
    'Cache-Control': 'no-store',
    'X-Cache': out.cached ? 'HIT' : 'MISS'
  }, securityHeaders()));
  res.end(out.body);
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  let found = resolveFile(PUBLIC_DIR, url.pathname);

  // SPA fallback: unknown paths that are not file requests render the app, so
  // /maps and /leaderboard work on a refresh and as shared links.
  if (!found && !path.extname(url.pathname)) {
    found = resolveFile(PUBLIC_DIR, '/index.html');
  }

  if (!found) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, securityHeaders()));
    res.end('Not found');
    return;
  }

  const fs = require('fs');
  const stat = fs.statSync(found.file);
  res.writeHead(200, Object.assign({
    'Content-Type': found.type,
    'Content-Length': stat.size,
    'Cache-Control': cacheHeader(found.file)
  }, securityHeaders()));

  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(found.file).pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch (_) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'faf-web',
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
      cacheEntries: cache.size(),
      playTab: false
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      log('error', 'unhandled', { reason: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }

  handleStatic(req, res, url);
});

server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;

function shutdown(sig) {
  log('info', 'shutting down', { signal: sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  server.listen(PORT, () => {
    log('info', 'listening', { port: PORT, publicDir: PUBLIC_DIR, playTab: false });
  });
}

module.exports = { server };
