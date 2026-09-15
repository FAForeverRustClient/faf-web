'use strict';

/**
 * Every upstream this service is allowed to talk to, and nothing else.
 *
 * This file is the whole security model of the proxy. A proxy that forwards
 * wherever the caller points it is an open relay: someone finds it, and your
 * host is suddenly fetching things on strangers' behalf, from your IP, with
 * your reputation. So the client never sends a URL. It sends a route name that
 * must appear here, and the path is rebuilt on this side.
 *
 * Endpoints were read out of the FAF desktop client
 * (FAForeverRustClient/crates/faf-app/src/infra/*.rs), not guessed.
 */

const UPSTREAMS = {
  // FAF's JSON:API. Everything is GET {base}/data/{resource} with JSON:API
  // query params (filter, sort, include, page[size], page[number]).
  faf: {
    base: 'https://api.faforever.com',
    prefix: '/data/',
    // Resource allowlist. Adding a tab means adding its resource here.
    allow: new Set([
      'map', 'mapVersion',
      'mod', 'modVersion',
      'featuredMod',
      'leaderboard', 'leaderboardRating',
      'league', 'leagueSeason', 'leagueSeasonScore',
      'player', 'clan',
      'tutorialCategory', 'coopMission'
    ]),
    ttlMs: 60_000
  },

  // The tournament site. Proxying it here means the browser only ever talks to
  // one origin, so tournaments.doodlepros.com does NOT need CORS headers added.
  tourney: {
    base: 'https://tournaments.doodlepros.com',
    prefix: '/api/',
    allow: null, // any /api/ path; it is a public read API
    ttlMs: 30_000
  },

  // The events calendar is a plain JSON file in a GitHub repo the client team
  // controls. Verified to send access-control-allow-origin: *, so the browser
  // could fetch it directly, but routing it through here keeps one origin and
  // gives us caching.
  events: {
    base: 'https://raw.githubusercontent.com',
    prefix: '/FAForeverRustClient/events/main/',
    allow: new Set(['calendar.json']),
    ttlMs: 300_000
  }
};

/**
 * Turn a request path like /api/faf/leaderboardRating?sort=-rating into a
 * concrete upstream URL, or return null if it is not allowed.
 *
 * Returns null rather than throwing, so a caller cannot distinguish "bad route"
 * from "blocked route" and go probing.
 */
function resolve(routeName, rest, search) {
  const up = UPSTREAMS[routeName];
  if (!up) return null;

  // No traversal, no absolute URLs, no protocol-relative smuggling.
  if (!rest || rest.includes('..') || rest.includes('//') || rest.startsWith('/')) return null;
  if (!/^[A-Za-z0-9._~\/-]+$/.test(rest)) return null;

  if (up.allow) {
    const first = rest.split('/')[0];
    if (!up.allow.has(first)) return null;
  }

  const url = up.base + up.prefix + rest + (search || '');
  // Belt and braces: the built URL must still point at the intended host.
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.origin !== new URL(up.base).origin) return null;

  return { url: parsed.toString(), ttlMs: up.ttlMs };
}

module.exports = { UPSTREAMS, resolve };
