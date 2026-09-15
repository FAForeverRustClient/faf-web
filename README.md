# uid-relay

An HTTP wrapper around FAF's `faf-uid` binary, for the FAF mobile web client.

**Implemented and tested. Not yet deployed.** This README started as the
specification Seraphim-Noob wrote for it; it now describes what was actually
built and how it actually runs here, with the specification's requirements kept
as the checklist they were meant to be.

Two names, do not mix them up: **uid-relay** is this service, the repo, the
container and the volume. **faf-uid** is FAF's own unmodified binary that it
runs, and it keeps that name everywhere, including at `DATA_DIR/bin/faf-uid`.

Zero runtime dependencies. Plain Node.js `http`, no framework, no build step, no
`npm install` in production. The container clones this repo and runs `server.js`.

---

## Why this exists

The FAF lobby handshake ends with `auth { token, unique_id, session }`.
`unique_id` is an anti-smurf machine proof produced by FAF's own `faf-uid`
binary, run against the session id the lobby server just issued. A browser
cannot run a binary, so the mobile client's backend obtains the proof over HTTP
from a host that can.

Every mobile player authenticates with **their own** FAF token. The only thing
shared between them is this proof: one machine, honestly identified as one
machine. The consequences of that for FAF's moderation tooling are written up in
the client repository (`docs/notes/moderation-request.md`) and are being put to
the moderation team before any of this goes live. **That is the client project's
to carry, not this host's.** This service stays unannounced until they have their
answer.

This is not a FAForever project. It is a small service operated for the mobile
client, wrapping a binary FAForever publishes.

---

## The binary

The official release, not a rebuild:

```
https://github.com/FAForever/uid/releases/download/v4.0.7/faf-uid
```

`sha256 1136d0e1cd7e61682ad375043fdac4bae690bf63d7fdd98a7a3a1fb9ccac61da`

Verified against the published asset on 14 Sep 2026: 3,723,288 bytes, ELF 64-bit
x86-64, **statically linked**, so the base image's libc does not matter.

It is **not** committed to this repo. `scripts/ensure-faf-uid.js` fetches it into
the data volume on first boot, sets the executable bit, and checks the digest.
The digest is checked again on **every** service start, and a mismatch refuses to
start rather than serving something else.

The version and its digest live in exactly one file, `lib/release.js`. Pulling
"latest" is impossible here by construction. **If that file is ever bumped, the
client repository has to be told**, because it verifies a digest and the two must
not drift apart silently.

---

## The contract

```
POST /uid
Authorization: Bearer <shared secret>
Content-Type: application/json

{ "session": "1234567890" }
```

```
200 OK
{ "uid": "<the blob faf-uid printed on stdout>" }
```

Implementation is `faf-uid <session>`, the session id as a single plain argv
entry with no shell in between, and stdout returned verbatim apart from trimming
whitespace.

On failure, a non-2xx status and `faf-uid`'s **stderr** in the body:

```
502 Bad Gateway
{ "error": "faf-uid exited with code 3", "stderr": "Error initialising machine_info\n" }
```

`stderr` appears only on an error response, never alongside a `uid`. There is no
success shape that carries both, and the test suite fails if one ever appears.

| Status | Meaning |
|---|---|
| 200 | proof issued |
| 400 | body was not JSON, or `session` missing/empty/too long/has unsupported characters |
| 401 | bad or missing bearer token |
| 403 | caller's address is not in `ALLOW_IPS` |
| 405 | `/uid` was not a POST |
| 413 | body over 4 KB |
| 502 | faf-uid ran and failed, or produced nothing |
| 503 | every worker slot busy, `Retry-After: 2` |
| 504 | faf-uid exceeded `UID_TIMEOUT_MS` and was killed |

`session` accepts `[A-Za-z0-9_.:-]`, 1 to 64 characters. A JSON number is
accepted and stringified. Surrounding whitespace is trimmed. The charset is
deliberately wider than "digits only" so that a future change to FAF's session
format is not an outage on this side.

Two endpoints beyond the contract, neither of which the backend needs:

- `GET /health` - no auth, liveness only. Says nothing about the machine.
- `GET /fingerprint` - same bearer. See "Fingerprint stability".

---

## The six requirements, and how each is met

**1. Per session, never cached.** Every call spawns the binary. There is no cache
and no memoisation anywhere in the code. `uidtest.js` proves it with a counter
stub: two calls with an identical session id must advance the counter by exactly
one each.

**2. It is slow.** *Not here.* The ~15 s cold and ~2.4 s warm figures are desktop
client numbers, dominated by Windows WMI. Measured against the real binary on
Linux: **roughly 25 ms cold and 15 ms warm**, and twelve concurrent calls through
this service completed in **92 ms total**. The generous limits are still in
place, because being wrong in the other direction costs a login, but nothing
should ever approach them:

- 16 concurrent runs, nothing serialised behind a lock
- up to 64 queued beyond that, then a fast `503` with `Retry-After` rather than a
  queue that turns into a login timeout
- 25 s per-call ceiling, above the >20 s client-side request timeout asked for

**3. The fingerprint must be stable.** A long-lived container on a permanent
host, never recreated per call. Full detail below, including how to verify it and
what will move it.

**4. It must not be open to the internet.** Required bearer secret, compared in
constant time, minimum 24 characters, service refuses to start without one.
Optional IP allowlist on top, which is the intended configuration once the
backend's egress address is known. Details below, because the allowlist is the
one piece that is easy to get subtly wrong behind a reverse proxy.

**5. Do not log the proofs.** Each request logs the session id, caller address,
status and duration. The proof is never passed to the logger on any path,
including error paths. `uidtest.js` asserts it by grepping a real run's output
for the blob it just issued, and that assertion was plant-validated.

**6. No console suppression needed.** Correct, nothing to do.

---

## What measuring it changed

Three findings that the specification could not have known, all verified against
the real binary rather than reasoned about.

**It writes to stderr when it succeeds.** On any headless server it prints
`xrandr: not found` and `lspci: not found` on every single run and still exits 0
with a perfectly good proof. **stderr is not a failure signal, the exit code is.**
A service that treats stderr as failure is permanently broken on every server.
Flagging it because anything else that ever shells out to this binary will hit
the same trap.

**The same session does not produce the same blob twice.** Output is a
length-prefixed base64 structure with a random AES IV at the front, so two runs
of an identical session id differ. Beyond reinforcing "never cache", this has one
practical consequence: **fingerprint stability cannot be checked by diffing two
proofs**, which is the obvious way to try. Hence `/fingerprint`.

**What it actually reads to identify the machine**, taken out of the binary:

```
/sys/class/dmi/id/{sys_vendor,product_name,board_vendor,board_name,
                   bios_vendor,bios_version,bios_date}
/var/lib/dbus/machine-id
/proc/cpuinfo, /proc/meminfo
uname -s, uname -r
lsblk --json -o SERIAL,NAME,MOUNTPOINT
lspci -n
xrandr
```

The last three resolve through `PATH`, which is why the child process
environment is pinned in `lib/uid.js`. If `PATH` drifts, the fingerprint drifts,
and a drifted fingerprint is a different machine as far as FAF is concerned.

---

## How it runs here

Dockhand plus Nginx Proxy Manager, on the same host as tournaments.doodlepros.com.
No image build; the container clones this repo at start, the same pattern that
site uses.

1. Create the repo and upload these files. `lib/` and `scripts/` must land as
   folders.
2. Generate a secret: `openssl rand -hex 24`.
3. Create the stack from `docker-compose.yml`, pasting that secret into
   `UID_SECRET`. It lives in the Dockhand config, never in this repo.
4. Start it. First boot downloads and verifies the binary.
5. Check the log for three lines: `machine fingerprint`, `self test ok`,
   `listening`. If instead you see `checksum mismatch` or `SELF TEST FAILED`,
   stop and fix that before putting anything in front of it.
6. Point an NPM proxy host at `<host>:8097`. **Cache Assets OFF** - caching a uid
   response would serve a stale proof for the wrong session, the single failure
   this design exists to avoid.
7. Run `node scripts/machine-preview.js` in the container and send the output to
   the client team. See "What a moderator sees".
8. When the backend's egress IP arrives, put it in `ALLOW_IPS` and restart.

### Two deliberate differences from the tourney stack

- **`node:20-bookworm`, not `node:20-alpine`.** The binary calls
  `lsblk --json -o SERIAL,NAME,MOUNTPOINT`, and busybox `lsblk` does not support
  those flags. The full bookworm image also ships `git`, so nothing is
  apt-installed at container start and there is one less thing that can vary
  between restarts.
- **`/etc/machine-id` is bind-mounted read-only** at `/host/machine-id`, so the
  identity is the real host's.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8097` | HTTP port. |
| `DATA_DIR` | `/data` | Volume holding `bin/faf-uid`, `machine-id`, `fingerprint.json`. |
| `UID_SECRET` | none | **Required.** Bearer secret. Under 24 chars is refused. |
| `ALLOW_IPS` | empty | Comma separated allowlist, single addresses or CIDR. Empty means the secret is the only gate. |
| `TRUST_PROXY` | RFC1918 | Whose `X-Forwarded-For` is believed. Narrow this to NPM once its address is known. |
| `MAX_CONCURRENCY` | `16` | Parallel runs. **Do not set to 1.** |
| `MAX_QUEUE` | `64` | Waiting requests before a fast 503. |
| `QUEUE_WAIT_MS` | `10000` | How long a request waits for a slot. |
| `UID_TIMEOUT_MS` | `25000` | Per-call ceiling, then the process group is killed. |
| `UID_BINARY` | `$DATA_DIR/bin/faf-uid` | Path to the binary. |
| `UID_SKIP_HASH_CHECK` | unset | `1` skips the startup checksum check. Testing only. |
| `UID_LOCAL_SOURCE` | unset | Install the binary from a local path instead of downloading. |

### The allowlist behind a proxy

NPM terminates the connection, so the address this service sees is always the
proxy's. An allowlist checked against that would allow the entire internet. The
real client address comes from `X-Forwarded-For`, but a service that trusts
`X-Forwarded-For` blindly is **worse** than one with no allowlist at all, because
anyone can then set the header to an allowed value and walk through.

So the header is read only when the direct peer is itself in `TRUST_PROXY`, and
it is walked from the right, skipping hops that are themselves trusted. The first
untrusted address is the client.

- `TRUST_PROXY` = the proxy, and nothing wider.
- `ALLOW_IPS` = the backend's public egress address.
- If `ALLOW_IPS` is set and `TRUST_PROXY` is wrong, **everything 403s**, because
  the only address ever seen is the proxy's.

The suite covers the spoof, the chain, a forged earlier hop, and the CIDR edges.

---

## Fingerprint stability

What must not happen is the fingerprint moving around and making one host look
like many. Since a proof cannot be compared against another proof, the service
reads the same inputs the binary reads, hashes each one, records the digest in
`DATA_DIR/fingerprint.json`, and on every start compares it against the previous
boot. If it moved, it logs a warning **naming the fields that moved**.

```
node scripts/fingerprint-report.js
curl -H "Authorization: Bearer $UID_SECRET" http://localhost:8097/fingerprint
```

The digest is local to this service. It is not FAF's `uid_hash` and means nothing
to FAF.

**Pinned:** `machine-id` from the host's real `/etc/machine-id` through the
read-only bind mount, with a persistent value in the data volume as fallback.
Container hostname fixed. Child process `PATH`, locale and timezone fixed.
Verified stable across a restart end to end before delivery.

**What will move it:**

- A host kernel upgrade (`uname -r`). Expected and unavoidable.
- Changing host RAM or CPU.
- Adding or removing a volume mount, which can change `lsblk` output.
- Installing `pciutils` or `xrandr` in the image. Do not. Absence is stable.
- **Renaming the stack, service or volume**, which creates a fresh empty volume
  and therefore a new machine-id. The names were settled before first deploy on
  purpose. Rename nothing afterwards.

None of these break anything by themselves; FAF simply sees a different machine,
as it would for any player who upgrades a PC. But if the client team is ever
chasing an anti-smurf oddity, this log line is the first thing to check.

---

## What a moderator sees

FAF's moderator client can search a decrypted proof by *Device Id*, *CPU Name*,
*Manufacturer*, *Bios Version*, *Serial Number*, *Volume Serial Number* and
*Memory Serial Number*, so what this host reports is what a moderator sees next
to every mobile player's account.

```
node scripts/machine-preview.js
```

That prints the real value behind each of those fields and flags the empty ones.
Run it once after deploy and send the output to the client team. **It prints
identifying values rather than hashes**, so it is fine to share with them and not
fine to paste in public.

Part of the answer is already known from the binary, and is a property of the
Linux build rather than of any particular host:

- **Serial Number will always be empty.** The v4.0.7 Linux binary references
  seven DMI attributes and not one of them is a serial. There is no
  `product_serial`, no `board_serial`, no `product_uuid`.
- **Memory Serial Number will always be empty.** Nothing in the binary reads one,
  and Linux exposes no source for it without `dmidecode`.
- **Volume Serial Number** comes from `lsblk SERIAL`, which reports `null` for
  every device on a VM with virtio disks or without udev serial data. Whether it
  populates has to be measured on the actual host, which is what the script is
  for.

So a moderator looking at a mobile player should be expected to find several of
those fields blank. Worth the client team knowing before a moderator asks why,
rather than after.

---

## Operations

**Logs** are one JSON object per line: session id, caller address, status,
duration. Never the proof.

**When it stops answering**, a mobile player's Play tab stops working
immediately. In order:

1. `curl http://<host>:8097/health`. If that answers, the process is alive and it
   is the proxy or the allowlist.
2. Check the boot log for `self test ok`. If the self test failed, the binary
   does not run on this host any more and nothing else will work.
3. `docker logs`, look for `uid failed`. The `stderr` field is the binary's own
   complaint and is usually the only thing that says what went wrong.
4. A restart re-verifies the checksum and re-runs the self test, so it is a
   reasonable first move.

**Updating the pinned version:** edit `lib/release.js`, delete
`DATA_DIR/bin/faf-uid`, restart, then tell the client repository.

---

## Testing

```bash
npm run check                            # node --check every source file
npm test                                 # the suite
REAL_FAF_UID=/path/to/faf-uid npm test   # plus the real-binary block
```

`uidtest.js` boots the real server over real HTTP against stub binaries
reproducing each faf-uid behaviour, then runs a block against the genuine binary
if one is given. **91 checks, 0 failing.**

The suite was validated by planting six real bugs and confirming each is caught:
stderr leaked into the success field, concurrency serialised to one, blind
`X-Forwarded-For` trust, the proof written to the log, per-session caching, and
session validation removed. A suite that has not been proven to fail is not
evidence.

Two real bugs it caught during development, both fixed and both worth not
reintroducing:

- A timed-out run needs the process **group** killed. `faf-uid` shells out to
  helpers, and killing only the parent leaves grandchildren holding the stdout
  pipe, so `close` never fires. A 700 ms timeout took 5 s.
- A 413 must not destroy the socket before the response is written, or the caller
  gets a socket hang up instead of a status code.

---

## What the client needs recorded here

1. **Base URL and auth scheme.** `POST https://[[ FQDN ]]/uid`, with
   `Authorization: Bearer <secret>`. The secret goes through a channel that is
   not this repository. An IP allowlist sits in front of it and is switched on as
   soon as the backend's egress address is supplied.
2. **faf-uid version deployed.** `v4.0.7`, official asset, digest pinned in
   `lib/release.js` and verified on every start.
3. **Host or container, stable across restarts.** A long-lived container on a
   permanent host. Stable, with the pinning and the verification described above.
4. **Concurrency and timeout.** 16 concurrent, 64 queued, fast 503 beyond that,
   25 s per-call ceiling. Real-world cost is about 25 ms per call.
5. **Who to contact, and who else can deploy.** Primary: [[ NAME / DISCORD ]],
   same contact as tournaments.doodlepros.com. Second person with deploy access:
   [[ NAME, or "none - single operator" ]]. Say which honestly; a bus factor of
   one is a fact the client should have rather than a gap they discover.
