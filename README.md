# faf-web

A mobile web companion for Forged Alliance Forever. News, tournaments, events,
leaderboard, maps, mods, unit database, training links, changelog.

**There is no Play tab, on purpose.** Joining and hosting games needs the
`unique_id` machine proof, which a browser cannot produce and which a shared
relay would present identically for every player. That question is unresolved
with FAF, so the lobby is simply not part of this build. The long-term fix is a
server-side change on FAF's side so lobby information is available through an
API this client can read, at which point the Play tab comes back without needing
a machine proof at all.

Nothing else here depends on it, which is why everything else can ship now.

Zero runtime dependencies, no build step, no database, no secrets. Upload the
files, restart the container.

---

## What it is, in one diagram

```
browser  ──►  faf-web  ──►  api.faforever.com          (maps, mods, leaderboard)
                        ──►  tournaments.doodlepros.com (tournaments)
                        ──►  raw.githubusercontent.com  (events calendar)
         └─ same origin ─┘
```

Everything the browser fetches comes from this origin. The service proxies
onward. That is the central design decision and it buys three things:

1. **CORS stops mattering.** It does not matter whether `api.faforever.com`
   allows browser origins, because no browser ever calls it directly. This was
   not a preference: it could not be verified either way from the build
   environment, and designing around the unknown was cheaper than gambling.
2. **`tournaments.doodlepros.com` needs no changes.** Calling it from a browser
   directly would have meant adding CORS headers there, a change to a second
   codebase. Proxying avoids it entirely.
3. **One origin means one CSP**, one TLS certificate, and no preflight requests.

The cost is that the service has to be up for the app to work. For a companion
app that is an acceptable trade; it is up anyway to serve the page.

---

## The proxy, and why it is not an open relay

`lib/upstreams.js` is the entire security model and is worth reading before
changing anything.

**The browser never sends a URL.** It sends a route name (`faf`, `tourney`,
`events`) plus a path, both of which must appear in an allowlist, and the real
URL is rebuilt on this side. A proxy that forwards wherever the caller points it
is an open relay: someone finds it, and your host starts fetching things on
strangers' behalf, from your IP.

Also enforced:

- **GET only.** Nothing here can change anything upstream.
- **No credentials forwarded, ever.** The outgoing header set is exactly
  `User-Agent` and `Accept`, as a frozen constant the suite asserts against.
  Browser cookies and `Authorization` headers are dropped, so this cannot be
  tricked into acting as a logged-in user.
- **Resource allowlist** per upstream. Adding a tab means adding its resource.
- **Blocked and unknown answer identically**, so the allowlist cannot be probed.
- **Caps**: 8 MB per response, 15 s timeout, bounded cache of 500 entries.
- **Upstream HTML error pages are not forwarded.** JSON errors are, because they
  are small and say something useful.

Endpoints were read out of the FAF desktop client
(`FAForeverRustClient/crates/faf-app/src/infra/*.rs`), not guessed.

---

## Tabs, and what each one actually does

| Tab | Source | Notes |
|---|---|---|
| News | `www.faforever.com/newshub` | embedded, with a direct link if framing is refused |
| Tournaments | `tournaments.doodlepros.com/api/tournaments` | returns a bare array, not a wrapped object |
| Events | community calendar JSON on GitHub | verified to allow browser origins anyway |
| Leaderboard | `/data/leaderboardRating`, global, top 50 | resolves the `player` relationship from `included` |
| Maps | `/data/map` + `latestVersion` | browse only; a browser cannot install to the game folder |
| Mods | `/data/mod` + `latestVersion` | same |
| Unit DB | `faforever.github.io/etfreeman-db` | embedded |
| Changelog | `faforever.github.io/fa/changelog` | embedded |
| Training | wiki and forum links | honest placeholder, see below |
| Chat | nothing yet | needs login, see below |

**Chat** is not stubbed out of laziness. FAF chat is IRC reachable over
`wss://chat.faforever.com`, so a browser can connect with no extra server. What
is missing is authentication: FAF's OAuth is a PKCE public-client flow the
browser could run unchanged, but the desktop client redirects to
`http://127.0.0.1:<port>`, which a browser cannot use. **FAF has to register a
web redirect URI** before login, and therefore chat, can work. That is a request
to FAF, not code.

When it is wired up, note that IRC nicknames are unique per connection. Unless
FAF's IRC server has multi-client mode enabled, being in chat here may collide
with being in chat on the desktop client.

**Training** is a link list. The desktop tab is built on a guides repository,
recorded build orders and replay analysis, none of which has a web equivalent
yet. Rather than fake it, the tab says so.

---

## Known unverified: the API field names

The build environment had no route to `api.faforever.com` (the egress proxy
refuses it), so **the exact JSON:API attribute names could not be checked against
the live API.** They were taken from the desktop client's Rust source, which is
good evidence but not proof.

Every field read goes through a `pick()` helper with fallbacks, and a missing
field renders as a dash rather than `undefined`. So a wrong guess degrades to a
blank column instead of a broken page.

**The first real load is the test.** If a column is empty, the fix is one line in
`public/app.js` - add the correct attribute name to the relevant `pick()` call.
The likely candidates are rating (`rating` vs `meanRating`), player name (`login`
vs `displayName`) and map thumbnails (`thumbnailUrlSmall` vs `thumbnailUrl`).

---

## Deploying on Dockhand

Same pattern as the tournament site and uid-relay: no image build, the container
clones the repo at start.

1. Create the repo and upload these files. `lib/` and `public/` must land as
   folders.
2. Paste `docker-compose.yml` into a Dockhand stack.
3. Start it. There are **no secrets and no volume** - nothing to configure,
   nothing to persist, and recreating the stack loses nothing.
4. Point an Nginx Proxy Manager host at `<host>:8098`.
   **Cache Assets OFF**, as on the tourney host.
5. Check the log for `listening`.

Port **8098**. uid-relay is 8097 and the tourney site is 8090.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8098` | HTTP port. |

That is the entire configuration surface.

### Headers it sets

`Content-Security-Policy` limits scripts to this origin, images to this origin
plus `content.faforever.com`, and framing to the three FAF pages that are
embedded. `X-Content-Type-Options: nosniff` and a strict referrer policy are set
on every response. The app shell is served `no-cache` so an update reaches people
on the next load rather than whenever their browser feels like it.

---

## Testing

```bash
npm run check   # node --check every source file
npm test        # 59 checks, no network required
```

`webtest.js` unit-tests the two pieces that carry real risk - the upstream
allowlist and the static path resolver - then boots the real server over real
HTTP for routing, the SPA fallback, method handling and security headers. The
proxy's upstream fetch is injectable, so timeouts, oversized bodies, 500s and
header hygiene are all driven with stubs rather than by hoping FAF answers.

**The suite was plant-validated against six real bugs.** Five were caught
immediately. The sixth, forwarding an `Authorization` header upstream, was
**not**, because the assertion inspected the stub's arguments rather than the
real header set. That was a false pass proving nothing, so the outgoing headers
were extracted into a frozen constant and the test now asserts against the actual
object. Re-planting the same bug now fails two checks.

### Browser check

```bash
npm i --no-save playwright-core
node browsercheck.js
```

Renders the app in real Chromium with fixture data, drives all eleven routes,
exercises in-app navigation, the back button, the mobile menu and Escape,
asserts there is no horizontal overflow at 390px, fails on any console or page
error, and writes `screenshot-mobile.png` and `screenshot-desktop.png`.

Asserting an element exists is not asserting it works, which is why this exists
alongside the unit suite.

---

## What is not here yet

- **The Play tab.** Waiting on FAF exposing lobby information through an API.
- **Login.** Waiting on FAF registering a web OAuth redirect URI. Until then
  every tab shows public data and nothing needs a session.
- **Chat**, which depends on login.
- **Real training content**, which depends on the client team deciding what the
  web version should contain.
- **Replays, clans, player cards.** The desktop client has them; nobody has
  asked for them here yet.

None of these are blocked by anything in this repo.
