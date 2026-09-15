'use strict';

/**
 * Renders the app in a real browser and checks that it actually works, rather
 * than that its elements exist.
 *
 * Dev-only. Not needed to run or deploy the service:
 *
 *   npm i --no-save playwright-core
 *   node browsercheck.js
 *
 * It boots the real server, intercepts /api/ with realistic JSON:API fixtures
 * (so no network is required and the shapes are pinned), then drives every
 * route and fails on any page error, any console error, or any route that
 * renders its failure state.
 *
 * External iframes (news, changelog, unit db) are stubbed, because the point
 * here is our code, and a blocked third-party frame would only add noise.
 */

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? '  -> ' + detail : '')); return false;
}

/* ------------------------------------------------------------- fixtures */

const FIXTURES = {
  leaderboardRating: {
    data: [
      { type: 'leaderboardRating', id: '1', attributes: { rating: 2143.7, totalGames: 812 },
        relationships: { player: { data: { type: 'player', id: '77' } } } },
      { type: 'leaderboardRating', id: '2', attributes: { rating: 1980.2, totalGames: 401 },
        relationships: { player: { data: { type: 'player', id: '78' } } } }
    ],
    included: [
      { type: 'player', id: '77', attributes: { login: 'Tagada' } },
      { type: 'player', id: '78', attributes: { login: 'Nuggets' } }
    ]
  },
  map: {
    data: [
      { type: 'map', id: '10', attributes: { displayName: 'Seton’s Clutch', author: 'GPG' },
        relationships: { latestVersion: { data: { type: 'mapVersion', id: '100' } } } }
    ],
    included: [
      { type: 'mapVersion', id: '100',
        attributes: { maxPlayers: 8, width: 1024, height: 1024, thumbnailUrlSmall: '/icon.svg' } }
    ]
  },
  mod: {
    data: [
      { type: 'mod', id: '20', attributes: { displayName: 'Total Mayhem', author: 'Burnie' },
        relationships: { latestVersion: { data: { type: 'modVersion', id: '200' } } } }
    ],
    included: [{ type: 'modVersion', id: '200', attributes: { thumbnailUrl: '/icon.svg' } }]
  },
  tournaments: [
    { id: 'abc123', name: 'Legend of the Stars', status: 'running', eventDate: '2026-10-04T18:00:00Z' },
    { id: 'def456', name: 'Monthly Cup', status: 'signup', eventDate: '2026-11-01T17:00:00Z' }
  ],
  calendar: [
    { title: 'Community Game Night', startsAt: '2026-09-20T19:00:00Z',
      description: 'Casual 4v4 lobbies.', url: 'https://example.invalid/night' }
  ]
};

/* --------------------------------------------------------------- harness */

function startServer() {
  const port = 23000 + Math.floor(Math.random() * 5000);
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = setInterval(() => {
      if (out.includes('"msg":"listening"')) {
        clearInterval(tick);
        resolve({ port, stop: () => new Promise((r) => { proc.once('close', r); proc.kill('SIGTERM'); }) });
      } else if (Date.now() > deadline) { clearInterval(tick); reject(new Error('no start: ' + out)); }
    }, 40);
  });
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.port;
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });

  const consoleErrors = [];
  const pageErrors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

  await context.route('**/api/**', (route) => {
    const url = route.request().url();
    let body;
    if (url.includes('/api/faf/leaderboardRating')) body = FIXTURES.leaderboardRating;
    else if (url.includes('/api/faf/map')) body = FIXTURES.map;
    else if (url.includes('/api/faf/mod')) body = FIXTURES.mod;
    else if (url.includes('/api/tourney/tournaments')) body = FIXTURES.tournaments;
    else if (url.includes('/api/events/calendar.json')) body = FIXTURES.calendar;
    else return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  // Stub the third-party embeds so a blocked frame is not mistaken for a bug.
  await context.route(/faforever\.(com|github\.io)/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stubbed upstream page</h1>' }));

  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const routes = [
    ['/', 'FAF Web'],
    ['/leaderboard', 'Tagada'],
    ['/maps', 'Seton'],
    ['/mods', 'Total Mayhem'],
    ['/tournaments', 'Legend of the Stars'],
    ['/events', 'Community Game Night'],
    ['/training', 'Training'],
    ['/chat', 'Chat'],
    ['/news', 'News'],
    ['/changelog', 'Changelog'],
    ['/units', 'Unit database']
  ];

  for (const [route, expect] of routes) {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    const text = await page.locator('#view').innerText();
    ok(text.includes(expect), 'renders ' + route + ' (expects "' + expect + '")',
      text.slice(0, 90).replace(/\n/g, ' '));
    ok(!/Could not load/.test(text), route + ' does not render its failure state');
  }

  // Client-side navigation must work without a full page load.
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.click('a[href="/maps"][data-link]');
  await page.waitForTimeout(400);
  ok((await page.locator('#view').innerText()).includes('Seton'),
    'in-app navigation renders without a reload');
  ok(page.url().endsWith('/maps'), 'in-app navigation updates the URL', page.url());

  // Back button.
  await page.goBack();
  await page.waitForTimeout(300);
  ok((await page.locator('#view').innerText()).includes('no Play tab'),
    'the back button returns to the previous view');

  // The mobile menu.
  await page.click('#menuBtn');
  await page.waitForTimeout(250);
  ok(await page.locator('#sidenav.open').count() === 1, 'the mobile menu opens');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok(await page.locator('#sidenav.open').count() === 0, 'Escape closes the menu');

  // No horizontal scrolling at phone width.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, 'no horizontal overflow at 390px', 'overflow=' + overflow + 'px');

  await page.screenshot({ path: 'screenshot-mobile.png', fullPage: true });

  // Desktop layout.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base + '/leaderboard', { waitUntil: 'networkidle' });
  ok(await page.locator('.sidenav').isVisible(), 'the sidebar is visible on desktop');
  await page.screenshot({ path: 'screenshot-desktop.png' });

  ok(pageErrors.length === 0, 'no uncaught page errors', pageErrors.join(' | '));
  const realConsoleErrors = consoleErrors.filter((e) => !/favicon|ERR_/.test(e));
  ok(realConsoleErrors.length === 0, 'no console errors', realConsoleErrors.join(' | '));

  await browser.close();
  await server.stop();

  console.log('');
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    console.log('');
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('screenshots: screenshot-mobile.png, screenshot-desktop.png');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
