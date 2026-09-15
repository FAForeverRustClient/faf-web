'use strict';

/**
 * Shows what a FAF moderator will see next to every mobile player's account.
 *
 *   node scripts/machine-preview.js
 *
 * FAF's moderator client can search a decrypted proof by Device Id, CPU Name,
 * Manufacturer, Bios Version, Serial Number, Volume Serial Number and Memory
 * Serial Number. This prints the raw values this host supplies for each, so the
 * answer to "what does this host look like to a moderator" is known before
 * anyone else looks at it rather than after.
 *
 * Two of those fields cannot be answered on Linux at all. The v4.0.7 binary
 * reads exactly seven DMI attributes - sys_vendor, product_name, board_vendor,
 * board_name, bios_vendor, bios_version, bios_date - and none of the serial
 * ones. There is no product_serial, no board_serial, no product_uuid and no
 * memory serial anywhere in it. That is a property of the Linux build, not of
 * this host and not something a different machine would fix.
 *
 * UNLIKE scripts/fingerprint-report.js, THIS PRINTS REAL VALUES, not hashes.
 * It identifies the host. Fine to share with the client team, do not paste it
 * into a public channel.
 */

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { CHILD_PATH } = require('../lib/uid');

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; }
}

function runOrNull(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: CHILD_PATH, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }
    }).trim();
  } catch (_) { return null; }
}

function dmi(field) {
  return readOrNull('/sys/class/dmi/id/' + field) || readOrNull('/sys/class/virtual/dmi/id/' + field);
}

function cpuName() {
  const raw = readOrNull('/proc/cpuinfo');
  if (!raw) return null;
  const m = /^model name\s*:\s*(.+)$/m.exec(raw);
  return m ? m[1].trim() : null;
}

function volumeSerials() {
  const raw = runOrNull('lsblk', ['--json', '-o', 'SERIAL,NAME,MOUNTPOINT']);
  if (!raw) return { available: false, entries: [] };
  try {
    const parsed = JSON.parse(raw);
    const entries = (parsed.blockdevices || []).map((d) => ({
      name: d.name, serial: d.serial, mountpoint: d.mountpoint
    }));
    return { available: true, entries };
  } catch (_) {
    return { available: false, entries: [] };
  }
}

const vols = volumeSerials();
const withSerial = vols.entries.filter((e) => e.serial);

const rows = [
  ['Device Id', readOrNull('/var/lib/dbus/machine-id'), 'from /var/lib/dbus/machine-id, pinned by prepare-machine-id.sh'],
  ['CPU Name', cpuName(), 'from /proc/cpuinfo'],
  ['Manufacturer', dmi('sys_vendor'), 'DMI sys_vendor'],
  ['Product Name', dmi('product_name'), 'DMI product_name'],
  ['Board', [dmi('board_vendor'), dmi('board_name')].filter(Boolean).join(' ') || null, 'DMI board_vendor + board_name'],
  ['Bios Vendor', dmi('bios_vendor'), 'DMI bios_vendor'],
  ['Bios Version', dmi('bios_version'), 'DMI bios_version'],
  ['Bios Date', dmi('bios_date'), 'DMI bios_date'],
  ['Serial Number', null, 'NOT READ on Linux - the binary references no DMI serial attribute'],
  ['Memory Serial Number', null, 'NOT READ on Linux - no source for it exists in the binary'],
  ['Volume Serial Number',
    withSerial.length ? withSerial.map((e) => e.name + '=' + e.serial).join(', ') : null,
    vols.available
      ? (withSerial.length ? 'from lsblk SERIAL' : 'lsblk ran but every device reported a null serial')
      : 'lsblk unavailable or unparseable'],
  ['Kernel', os.type() + ' ' + os.release(), 'uname -s / -r'],
  ['MemTotal', (readOrNull('/proc/meminfo') || '').split('\n').find((l) => l.startsWith('MemTotal')) || null, 'from /proc/meminfo']
];

const pad = Math.max(...rows.map((r) => r[0].length));

console.log('What a FAF moderator sees for every mobile player on this host');
console.log('='.repeat(62));
console.log('');
for (const [label, value, note] of rows) {
  console.log(label.padEnd(pad) + '  ' + (value === null || value === '' ? '(empty)' : value));
  console.log(' '.repeat(pad) + '  ' + note);
  console.log('');
}

const empties = rows.filter((r) => !r[1]).map((r) => r[0]);
if (empties.length) {
  console.log('Empty on this host: ' + empties.join(', '));
  console.log('');
  console.log('Serial Number and Memory Serial Number are expected to be empty and');
  console.log('will be empty on any Linux host. The rest being empty usually means');
  console.log('this is a VM without DMI exposed, or lsblk has no udev serial data.');
  console.log('Send this output to the client team so it is on record.');
}
