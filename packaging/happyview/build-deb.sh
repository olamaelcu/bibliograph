#!/usr/bin/env bash
# Build the bibliograph-happyview .deb from the staged payload.
#
# HappyView has no Node payload — its tree is a binary, migrations and static
# files extracted from the pinned image — so it is assembled with dpkg-deb and
# can be built and installed on its own. The package layout matches the other
# Bibliograph packages' conventions: /usr/lib/bibliograph, /etc/bibliograph,
# the shared `bibliograph` sysuser.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VERSION="${HAPPYVIEW_VERSION:-2.17.4}"
REVISION="${HAPPYVIEW_REVISION:-2}"
ARCH="${HAPPYVIEW_ARCH:-$(dpkg --print-architecture)}"
PAYLOAD="packaging/payload/happyview"
LIVE="/usr/lib/bibliograph-happyview"
STAGE="packaging/build/bibliograph-happyview_${VERSION}-${REVISION}_${ARCH}"
UNIT_DIR="$STAGE/usr/lib/systemd/system"
DEBIAN_DIR="$STAGE/DEBIAN"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -x "$PAYLOAD/happyview" ]] || die "no payload; run 'mise run package-hv-payload'"
[[ -d "$PAYLOAD/migrations/postgres" ]] || die "payload has no migrations"
[[ -d "$PAYLOAD/static" ]] || die "payload has no dashboard"
command -v dpkg-deb >/dev/null || die "dpkg-deb is required"
command -v python3 >/dev/null || die "python3 is required (hv-deploy runs on it)"

say "Assembling $STAGE"
rm -rf "$STAGE"
install -d "$STAGE"

# Runtime tree. HappyView loads ./migrations relative to its working directory,
# so this layout is the unit's WorkingDirectory as well.
install -D -m 0755 "$PAYLOAD/happyview" "$STAGE$LIVE/happyview"
cp -a "$PAYLOAD/migrations" "$STAGE$LIVE/migrations"
cp -a "$PAYLOAD/static" "$STAGE$LIVE/static"

# Everything the deploy oneshot uploads, straight from the source tree so the
# package always carries this commit's lexicons and scripts.
cp -a happyview/lexicons "$STAGE$LIVE/lexicons"
cp -a happyview/scripts "$STAGE$LIVE/scripts"
cp -a happyview/lib "$STAGE$LIVE/lib"
install -D -m 0644 happyview/sql/indexes.sql "$STAGE$LIVE/sql/indexes.sql"
install -D -m 0644 happyview/sql/admin-bootstrap.sql "$STAGE$LIVE/sql/admin-bootstrap.sql"
install -D -m 0755 happyview/bin/hv-deploy "$STAGE$LIVE/bin/hv-deploy"
install -D -m 0644 happyview/sql/client-bootstrap.sql "$STAGE$LIVE/sql/client-bootstrap.sql"
install -D -m 0755 happyview/bin/hv-client "$STAGE$LIVE/bin/hv-client"
install -D -m 0644 happyview/bin/hvlib.py "$STAGE$LIVE/bin/hvlib.py"
install -D -m 0755 packaging/happyview/bin/hv-prepare-static \
  "$STAGE$LIVE/bin/hv-prepare-static"

# Host-level example for exposing the dashboard at /hv to tailnet clients.
# Not installed into sites-enabled; the operator includes it from the vhost.
install -D -m 0644 packaging/happyview/nginx/hv-tailnet.conf \
  "$STAGE/usr/share/bibliograph-happyview/nginx/hv-tailnet.conf"
install -D -m 0644 packaging/happyview/nginx/edge-loopback.conf \
  "$STAGE/usr/share/bibliograph-happyview/nginx/edge-loopback.conf"

install -D -m 0644 packaging/happyview/happyview.env \
  "$STAGE/etc/bibliograph/happyview.env"
install -D -m 0644 packaging/happyview/db-init.sql \
  "$STAGE/usr/share/bibliograph-happyview/db-init.sql"
install -D -m 0644 packaging/happyview/happyview.service \
  "$UNIT_DIR/happyview.service"
install -D -m 0644 packaging/happyview/bibliograph-happyview-deploy.service \
  "$UNIT_DIR/bibliograph-happyview-deploy.service"
install -D -m 0644 packaging/happyview/bibliograph-happyview-client.service \
  "$UNIT_DIR/bibliograph-happyview-client.service"

# Debian policy: units live under /usr/lib; /lib is an aliased location that
# lintian rejects in a package built like this.
install -D -m 0644 packaging/happyview/copyright \
  "$STAGE/usr/share/doc/bibliograph-happyview/copyright"
gzip -9n -c packaging/happyview/changelog \
  > "$STAGE/usr/share/doc/bibliograph-happyview/changelog.Debian.gz"
chmod 0644 "$STAGE/usr/share/doc/bibliograph-happyview/changelog.Debian.gz"

# The image's binary arrives unstripped; strip it the way a production build
# would. It is the same code, and the package carries no debug files.
if command -v strip >/dev/null; then
  strip --strip-unneeded "$STAGE$LIVE/happyview"
fi

# Source directories are group-writable in the checkout; dpkg wants 0755 dirs
# and non-group-writable files.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod go-w {} +

# dpkg metadata. Installed-Size counts files only, so measure after the tree is
# final and before DEBIAN/ exists; it is reported in KiB by du -sk.
size="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"

install -D -m 0755 packaging/happyview/debian/postinst "$DEBIAN_DIR/postinst"
install -D -m 0755 packaging/happyview/debian/prerm "$DEBIAN_DIR/prerm"
install -D -m 0755 packaging/happyview/debian/postrm "$DEBIAN_DIR/postrm"
install -D -m 0644 packaging/happyview/debian/conffiles "$DEBIAN_DIR/conffiles"
sed -e "s/@VERSION@/${VERSION}-${REVISION}/" \
    -e "s/@ARCH@/${ARCH}/" \
    -e "s/@SIZE@/${size}/" \
    packaging/happyview/debian/control > "$DEBIAN_DIR/control"
chmod 0644 "$DEBIAN_DIR/control"

# Fail closed on anything that would install but not run.
[[ -x "$STAGE$LIVE/happyview" ]] || die "binary is not executable in the tree"
[[ -x "$STAGE$LIVE/bin/hv-deploy" ]] || die "deploy tool is not executable"
[[ -x "$STAGE$LIVE/bin/hv-client" ]] || die "client seeder is not executable"
[[ -x "$STAGE$LIVE/bin/hv-prepare-static" ]] \
  || die "static base-path helper is not executable"
[[ -n "$(find "$STAGE$LIVE/migrations/postgres" -name '*.sql' -print -quit)" ]] \
  || die "no migrations staged"
[[ -n "$(find "$STAGE$LIVE/lexicons" -name '*.json' -print -quit)" ]] \
  || die "no lexicons staged"
[[ -n "$(find "$STAGE$LIVE/scripts/xrpc" -name '*.lua' -print -quit)" ]] \
  || die "no scripts staged"
[[ -f "$STAGE$LIVE/lib/prelude.lua" ]] \
  || die "no lib/prelude.lua staged; every script includes it"

say "Building the package"
install -d dist
out="dist/bibliograph-happyview_${VERSION}-${REVISION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$out" >/dev/null
rm -rf "$STAGE"

say "Built $out"
dpkg-deb --field "$out" Package Version Architecture Installed-Size Depends
ls -lh "$out"
