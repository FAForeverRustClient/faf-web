'use strict';

/**
 * Static file serving for public/, with the SPA fallback.
 *
 * The path handling here is the part worth reading twice: a static server that
 * resolves a user-supplied path carelessly serves /etc/passwd. Every request
 * path is decoded, normalised and then checked to be inside the root before
 * anything is opened.
 */

const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @returns {{file:string, type:string}|null} null when the path escapes the root
 * or nothing matches.
 */
function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch (_) {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);

  // The containment check. path.resolve has already collapsed any "..".
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;

  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return null; }

  if (stat.isDirectory()) {
    const index = path.join(abs, 'index.html');
    try {
      if (fs.statSync(index).isFile()) return { file: index, type: contentType(index) };
    } catch (_) { /* fall through */ }
    return null;
  }
  if (!stat.isFile()) return null;

  return { file: abs, type: contentType(abs) };
}

/**
 * Cache policy: the app shell must never be cached, or an update never reaches
 * anyone and we relive the "Cache Assets" problem from the tourney site. Hashed
 * or versioned assets could be cached hard, but nothing here is versioned yet,
 * so everything is no-cache and correctness wins over a few kilobytes.
 */
function cacheHeader(file) {
  if (/\.(png|jpg|webp|svg|ico|woff2)$/i.test(file)) return 'public, max-age=3600';
  return 'no-cache';
}

module.exports = { resolveFile, contentType, cacheHeader, TYPES };
