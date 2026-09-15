'use strict';

/**
 * The pinned faf-uid release.
 *
 * v4.0.7 is what the mobile client pins in scripts/ensure-faf-uid.mjs, kept in
 * sync with the official Java client. The desktop client pins a digest, so the
 * two must not drift apart silently.
 *
 * If you bump this, TELL THE CLIENT TEAM. That is not politeness, it is the
 * whole reason the version is written down in two places.
 *
 * The checksum below was verified against the published asset on 14 Sep 2026.
 */
module.exports = {
  VERSION: 'v4.0.7',
  SHA256: '1136d0e1cd7e61682ad375043fdac4bae690bf63d7fdd98a7a3a1fb9ccac61da',
  URL: 'https://github.com/FAForever/uid/releases/download/v4.0.7/faf-uid',
  SIZE: 3723288,
  PLATFORM: 'linux-x86_64 (statically linked)'
};
