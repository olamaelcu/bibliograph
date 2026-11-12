#!/usr/bin/env bash
# Build the bibliograph-web .deb from the staged adapter-node output.
#
# This edge is assembled with dpkg-deb and must be installable on its own,
# keeping the repo's layout conventions (/usr/lib/bibliograph,
# /etc/bibliograph, the shared `bibliograph` sysuser).
#
# Architecture is `all`: the payload is JavaScript, and the runtime dependency
# on nodejs is expressed in Depends rather than satisfied by bundling.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PAYLOAD="packaging/payload/web"
LIVE="/usr/lib/bibliograph-web"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$PAYLOAD/build/index.js" ]] || die "no payload; run 'mise run package-web-payload'"
command -v dpkg-deb >/dev/null || die "dpkg-deb is required"
command -v python3 >/dev/null || die "python3 is required to read the package version"

package_version="$(python3 -c '
import json
print(json.load(open("packages/web/package.json"))["version"])
')"
VERSION="${WEB_VERSION:-$package_version}"
REVISION="${WEB_REVISION:-1}"
ARCH="all"
STAGE="packaging/build/bibliograph-web_${VERSION}-${REVISION}_${ARCH}"
UNIT_DIR="$STAGE/usr/lib/systemd/system"
DEBIAN_DIR="$STAGE/DEBIAN"

[[ -n "$VERSION" ]] || die "could not read the version from packages/web/package.json"

say "Assembling $STAGE"
rm -rf "$STAGE"
install -d "$STAGE"

install -d "$STAGE$LIVE"
cp -a "$PAYLOAD/build" "$STAGE$LIVE/build"

install -D -m 0644 packaging/web/web.env "$STAGE/etc/bibliograph/web.env"
# The TLS vhost is a conffile in sites-available only; packaging/web/debian/postinst enables it
# when a certificate exists and nginx accepts the result. It is not copied into
# sites-enabled here, so an installed package never breaks the host's nginx.
install -D -m 0644 packaging/web/nginx/bibliograph.conf \
  "$STAGE/etc/nginx/sites-available/bibliograph-web"
install -D -m 0644 packaging/web/bibliograph-web.service "$UNIT_DIR/bibliograph-web.service"
install -D -m 0644 packaging/web/copyright \
  "$STAGE/usr/share/doc/bibliograph-web/copyright"
gzip -9n -c packaging/web/changelog > "$STAGE/usr/share/doc/bibliograph-web/changelog.Debian.gz"
chmod 0644 "$STAGE/usr/share/doc/bibliograph-web/changelog.Debian.gz"

find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod go-w {} +

size="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"

install -D -m 0755 packaging/web/debian/postinst "$DEBIAN_DIR/postinst"
install -D -m 0755 packaging/web/debian/prerm "$DEBIAN_DIR/prerm"
install -D -m 0755 packaging/web/debian/postrm "$DEBIAN_DIR/postrm"
install -D -m 0644 packaging/web/debian/conffiles "$DEBIAN_DIR/conffiles"
sed -e "s/@VERSION@/${VERSION}-${REVISION}/" \
    -e "s/@ARCH@/${ARCH}/" \
    -e "s/@SIZE@/${size}/" \
    packaging/web/debian/control > "$DEBIAN_DIR/control"
chmod 0644 "$DEBIAN_DIR/control"

[[ -f "$STAGE$LIVE/build/index.js" ]] || die "payload lost build/index.js"
[[ -d "$STAGE$LIVE/build/client" ]] || die "payload lost client assets"

say "Building the package"
install -d dist
out="dist/bibliograph-web_${VERSION}-${REVISION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$out" >/dev/null
rm -rf "$STAGE"

say "Built $out"
dpkg-deb --field "$out" Package Version Architecture Installed-Size Depends
ls -lh "$out"
