#!/usr/bin/env bash
# Build the bibliograph-worker .deb from the staged payload
# (`mise run package-worker-payload`).
#
# The payload is plain ESM plus its production node_modules (graphile-worker,
# pg), deployed by `pnpm deploy --prod`, so the package runs on the host's
# nodejs with no package manager or build toolchain. Architecture is `all`:
# every shipped file is JavaScript or JSON.
#
# This worker package is standalone.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PAYLOAD="packaging/payload/worker"
LIVE="/usr/lib/bibliograph-worker"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$PAYLOAD/index.js" ]] || die "no payload; run 'mise run package-worker-payload'"
command -v dpkg-deb >/dev/null || die "dpkg-deb is required"
command -v python3 >/dev/null || die "python3 is required to read the package version"

package_version="$(python3 -c '
import json
print(json.load(open("packages/worker/package.json"))["version"])
')"
VERSION="${WORKER_VERSION:-$package_version}"
REVISION="${WORKER_REVISION:-1}"
ARCH="all"
STAGE="packaging/build/bibliograph-worker_${VERSION}-${REVISION}_${ARCH}"
UNIT_DIR="$STAGE/usr/lib/systemd/system"
DEBIAN_DIR="$STAGE/DEBIAN"

[[ -n "$VERSION" ]] || die "could not read the version from packages/worker/package.json"

say "Assembling $STAGE"
rm -rf "$STAGE"
install -d "$STAGE"

install -d "$STAGE$LIVE"
cp -a "$PAYLOAD/." "$STAGE$LIVE/"
rm -rf "$STAGE$LIVE/test"

# The versioned catalog schema. `mise run catalog-schema` applies it locally;
# `mise run deploy` applies the installed copy on the host, so a fresh
# deployment never needs this checkout or a second upload.
install -d "$STAGE$LIVE/sql"
cp -a packages/worker/sql/. "$STAGE$LIVE/sql/"

install -D -m 0644 packaging/worker/worker.env "$STAGE/etc/bibliograph/worker.env"
install -D -m 0644 packaging/worker/bibliograph-worker.service \
  "$UNIT_DIR/bibliograph-worker.service"
install -D -m 0644 packaging/worker/copyright \
  "$STAGE/usr/share/doc/bibliograph-worker/copyright"
gzip -9n -c packaging/worker/changelog \
  > "$STAGE/usr/share/doc/bibliograph-worker/changelog.Debian.gz"
chmod 0644 "$STAGE/usr/share/doc/bibliograph-worker/changelog.Debian.gz"

# The worker reads the whole payload at runtime; no file may be group-writable.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod go-w {} +
chmod 0640 "$STAGE/etc/bibliograph/worker.env"

size="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"

install -D -m 0755 packaging/worker/debian/postinst "$DEBIAN_DIR/postinst"
install -D -m 0755 packaging/worker/debian/prerm "$DEBIAN_DIR/prerm"
install -D -m 0755 packaging/worker/debian/postrm "$DEBIAN_DIR/postrm"
install -D -m 0644 packaging/worker/debian/conffiles "$DEBIAN_DIR/conffiles"
sed -e "s/@VERSION@/${VERSION}-${REVISION}/" \
    -e "s/@ARCH@/${ARCH}/" \
    -e "s/@SIZE@/${size}/" \
    packaging/worker/debian/control > "$DEBIAN_DIR/control"
chmod 0644 "$DEBIAN_DIR/control"

[[ -f "$STAGE$LIVE/index.js" ]] || die "payload lost index.js"
[[ -f "$STAGE$LIVE/node_modules/graphile-worker/package.json" ]] \
  || die "payload lost graphile-worker"
[[ -f "$STAGE$LIVE/node_modules/pg/package.json" ]] || die "payload lost pg"
compgen -G "$STAGE$LIVE/sql/*.sql" >/dev/null \
  || die "payload lost the catalog schema SQL (packages/worker/sql)"
command -v node >/dev/null || echo "WARN: node is not on PATH on this build host" >&2

say "Building the package"
install -d dist
out="dist/bibliograph-worker_${VERSION}-${REVISION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$out" >/dev/null
rm -rf "$STAGE"

say "Built $out"
dpkg-deb --field "$out" Package Version Architecture Installed-Size Depends
ls -lh "$out"
