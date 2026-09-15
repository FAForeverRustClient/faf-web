#!/bin/sh
# Pin the machine-id faf-uid reads.
#
# /var/lib/dbus/machine-id is one of the inputs to the fingerprint. In a
# container it is either missing or regenerated, which would make this host look
# like a brand new machine every time the container is recreated - the exact
# failure mode the client document warns about in point 3.
#
# Preference order:
#   1. /host/machine-id  - the real host's id, bind-mounted read-only by
#      docker-compose. This is the honest answer: there genuinely is one
#      machine behind all of this, and this is that machine's id.
#   2. DATA_DIR/machine-id - a stable id generated once and kept in the data
#      volume, for hosts where the bind mount is not available.
#
# Either way the value survives a restart. It does NOT survive deleting the
# volume AND losing the bind mount at the same time.

set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ -r /host/machine-id ] && [ -s /host/machine-id ]; then
  ID=$(tr -d ' \t\n\r' < /host/machine-id)
  SRC="host bind mount"
else
  mkdir -p "$DATA_DIR"
  if [ ! -s "$DATA_DIR/machine-id" ]; then
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA_DIR/machine-id"
    echo "[prepare-machine-id] generated a new persistent id in the data volume"
  fi
  ID=$(tr -d ' \t\n\r' < "$DATA_DIR/machine-id")
  SRC="data volume"
fi

if [ -z "$ID" ]; then
  echo "[prepare-machine-id] FAILED: empty machine id" >&2
  exit 1
fi

mkdir -p /var/lib/dbus
printf '%s\n' "$ID" > /var/lib/dbus/machine-id
printf '%s\n' "$ID" > /etc/machine-id

# The id itself is not printed. It is not a secret, but it is half of what
# identifies this host to FAF and there is no reason to put it in a log.
echo "[prepare-machine-id] machine-id pinned from $SRC"
