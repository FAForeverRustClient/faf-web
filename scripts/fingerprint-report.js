'use strict';

/**
 * Prints what faf-uid will see as this machine, without running faf-uid.
 *
 *   node scripts/fingerprint-report.js
 *
 * Run it on the host, then run it inside the container, and compare. Run it
 * again after a restart, after a kernel upgrade, after adding a volume. The
 * digest is the answer to "did the machine identity move".
 */

const { collect } = require('../lib/fingerprint');

const r = collect();
const pad = Math.max(...r.fields.map((f) => f.name.length));

console.log('faf-uid input fingerprint');
console.log('digest: ' + r.digest);
console.log('(local change-detector only - this is NOT FAF\'s uid_hash)');
console.log('');
for (const f of r.fields) {
  console.log(
    '  ' + f.name.padEnd(pad) +
    '  ' + (f.present ? 'present' : 'ABSENT ') +
    '  ' + f.hash +
    (f.note ? '   # ' + f.note : '')
  );
}
console.log('');
console.log('Fields marked ABSENT are fine as long as they stay absent.');
console.log('A field that appears or disappears moves the fingerprint.');
