# uid-relay

An HTTP wrapper around FAF's `faf-uid` binary, for the FAF mobile web client.

Nothing is implemented yet. This README is the specification the implementation
has to meet, and it is the contract the client's backend will be written
against.

---

## Why this exists

The FAF lobby handshake ends with `auth { token, unique_id, session }`.
`unique_id` is an anti-smurf machine proof produced by FAF's own `faf-uid`
binary, run against the session id the lobby server just issued. A browser
cannot run a binary, so the mobile client's backend obtains the proof over HTTP
from a host that can.

Every mobile player authenticates with **their own** FAF token. The only thing
shared between them is this proof — one machine, honestly identified as one
machine. The consequences of that for FAF's moderation tooling are written up
separately in the client repository (`docs/notes/moderation-request.md`) and are
being put to the moderation team before any of this goes live.

This is not a FAForever project. It is a small service operated for the mobile
client, wrapping a binary FAForever publishes.

---

## The binary

The official release, not a rebuild:

```
https://github.com/FAForever/uid/releases/download/v4.0.7/faf-uid
```

`sha256 1136d0e1cd7e61682ad375043fdac4bae690bf63d7fdd98a7a3a1fb9ccac61da`

That is the Linux x86_64 asset, and v4.0.7 is the version the client pins
(`scripts/ensure-faf-uid.mjs` there), kept in sync with the official Java
client. It needs the executable bit.

**Pin it.** A deployment that pulls "latest" will drift away from the desktop
client without anyone noticing. If a newer release is deployed here, the client
repository has to be told, because it verifies a digest.

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

Implementation is `faf-uid <session>`, with the session id as a single plain
string argument, and stdout returned verbatim apart from trimming whitespace.

On failure, a non-2xx status and `faf-uid`'s **stderr** in the body. Its own
complaint is usually the only thing that says what went wrong, and the client
has already been burned once by losing it: a helper error passed through as if
it were a proof reaches the lobby server as a credential, which answers with a
bare `{"command": "invalid"}` and drops the connection, naming neither the
helper nor the reason. Never return stderr in the success field.

---

## Six things that matter

**1. Per session, never cached.** The proof is computed over the session id, and
the lobby server sends both the proof and the session to the policy service. A
cached blob is not a valid proof for a different session. Every call runs the
binary.

**2. It is slow.** Measured in the desktop client: ~15 s on a cold first run,
~2.4 s warm. Worth measuring here, but plan for seconds, not milliseconds — and
for several calls in flight at once, since every mobile player opening the Play
tab produces one. Do not serialise them behind a single lock: a queue of
2-second runs becomes a login timeout. Request timeout should sit above 20 s.

**3. The fingerprint must be stable.** All mobile players will present the same
proof, and that is the honest thing for them to present, because there genuinely
is one machine behind them. If the service runs in throwaway containers whose
machine identifiers change per call, it would instead look like many machines to
FAF's anti-smurf system, which is the opposite of what is wanted. Run it on the
host, or in a long-lived container, and record which — and whether the value
survives a restart.

**4. It must not be open to the internet.** Anything that can call this endpoint
can mint lobby-valid machine proofs carrying this host's identity, and whatever
is then done with them is associated with this machine. A shared secret in an
`Authorization` header is the minimum; an IP allowlist on top is better, since
exactly one backend will ever call it.

**5. Do not log the proofs.** They are credentials. Session ids are short-lived
and fine to log; the blob is not.

**6. No console suppression needed.** The desktop client hides the helper's
console window on Windows. On a Linux server there is nothing to hide.

---

## Where it can run

Either on the same host as the mobile backend or somewhere else entirely. The
lobby server never correlates the proof with the address the connection comes
from — the policy payload it sends carries no address at all. So this service
may sit behind a private network, a VPN or a firewall rule, and the backend may
be hosted anywhere.

---

## One check to run once it stands

Run `faf-uid` on the host once and keep the output. FAF's moderator client can
search the decrypted proof by *Device Id*, *CPU Name*, *Manufacturer*, *Bios
Version*, *Serial Number*, *Volume Serial Number* and *Memory Serial Number*, so
what the binary reports here is what a moderator will see next to every mobile
player's account. A datacenter host should not read like a gaming PC, and if
some fields come back empty or synthetic on this hardware, that is worth knowing
before anyone else notices it rather than after.

---

## What the client needs recorded here

1. The base URL and the auth scheme. The secret goes through a channel that is
   not this repository.
2. The `faf-uid` version actually deployed.
3. Host or container, and whether the proof is stable across restarts.
4. How many concurrent calls it tolerates, and its timeout.
5. Who to contact when it stops answering, and who besides them can deploy —
   a mobile player's Play tab stops working the moment this does.
