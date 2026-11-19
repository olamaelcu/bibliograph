#!/usr/bin/env bash
# Write DEBIAN/md5sums for a staged package tree.
#
# `dpkg-deb --build` does not generate this file, and the deploy uses it as the
# payload identity: a rebuilt deb with the same content has the same list, so
# the host can skip a reinstall (about 40s each on the production disk, 103s
# for HappyView with its oneshot). Conffiles are excluded because their copies
# on the host are expected to differ (the env files carry the secrets).
#
# usage: packaging/md5sums.sh <stage-dir>

set -euo pipefail

stage="$(cd "${1:?stage dir}" && pwd)"
debian="$stage/DEBIAN"
[ -d "$debian" ] || { printf 'no DEBIAN dir in %s\n' "$stage" >&2; exit 1; }

cd "$stage"
find . -path ./DEBIAN -prune -o -type f -print0 \
  | sed -z 's|^\./||' \
  | while IFS= read -r -d '' path; do
      if [ -r "$debian/conffiles" ]; then
        while IFS= read -r conf; do
          [ -n "$conf" ] || continue
          conf="${conf#/}"
          [ "$conf" = "$path" ] && continue 2
        done < "$debian/conffiles"
      fi
      printf '%s\0' "$path"
    done \
  | xargs -0 -r md5sum > "$debian/md5sums"
