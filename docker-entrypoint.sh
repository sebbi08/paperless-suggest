#!/bin/sh
# Bind-mounted data directories are created by Docker as root. When started as root,
# create DATA_DIR, hand it to USERMAP_UID:USERMAP_GID, then drop privileges.
set -e

if [ "$(id -u)" = "0" ]; then
  uid="${USERMAP_UID:-1000}"
  gid="${USERMAP_GID:-1000}"
  mkdir -p "$DATA_DIR"
  chown -R "$uid:$gid" "$DATA_DIR"
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
fi

exec "$@"
