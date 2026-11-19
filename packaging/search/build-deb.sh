#!/usr/bin/env bash
# Build the bibliograph-search .deb from the Rust crate in `search/`.
#
# The service is a native binary, not JavaScript: architecture matters. The
# deployment host is Debian 12 (glibc 2.36), while a workstation is commonly
# newer, so the default build is a **static musl** binary that cannot pick up
# the build host's glibc. If the musl target is missing the script says exactly
# how to add it; SEARCH_ALLOW_HOST_GLIBC=1 is the escape hatch for packaging a
# throwaway host-glued binary to inspect the layout, never for a release.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CRATE="search"
LIVE="/usr/lib/bibliograph-search"
TARGET="x86_64-unknown-linux-musl"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v dpkg-deb >/dev/null || die "dpkg-deb is required"
command -v cargo >/dev/null || die "cargo is required"
[[ -f "$CRATE/Cargo.toml" ]] || die "no $CRATE/Cargo.toml"

VERSION="${SEARCH_VERSION:-$(
  sed -n 's/^version = "\(.*\)"$/\1/p' "$CRATE/Cargo.toml" | head -1
)}"
REVISION="${SEARCH_REVISION:-1}"
ARCH="amd64"
[[ -n "$VERSION" ]] || die "could not read the version from $CRATE/Cargo.toml"

say "Building $CRATE ($TARGET)"
if [[ "${SEARCH_ALLOW_HOST_GLIBC:-0}" != "1" ]]; then
  if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    die "the $TARGET target is not installed; run 'rustup target add $TARGET' (and install musl-tools) so the binary does not depend on this host's glibc"
  fi
  cargo build --locked --release --manifest-path "$CRATE/Cargo.toml" --target "$TARGET"
  BINARY="$CRATE/target/$TARGET/release/bibliograph-search"
else
  printf 'WARN: SEARCH_ALLOW_HOST_GLIBC=1 — the binary will not run on a host with an older glibc\n' >&2
  cargo build --locked --release --manifest-path "$CRATE/Cargo.toml"
  BINARY="$CRATE/target/release/bibliograph-search"
fi
[[ -x "$BINARY" ]] || die "build produced no binary at $BINARY"

STAGE="packaging/build/bibliograph-search_${VERSION}-${REVISION}_${ARCH}"
UNIT_DIR="$STAGE/usr/lib/systemd/system"
DEBIAN_DIR="$STAGE/DEBIAN"

say "Assembling $STAGE"
rm -rf "$STAGE"
install -d "$STAGE"

install -D -m 0755 "$BINARY" "$STAGE$LIVE/bibliograph-search"
install -D -m 0644 packaging/search/search.env "$STAGE/etc/bibliograph/search.env"
install -D -m 0644 packaging/search/bibliograph-search.service \
  "$UNIT_DIR/bibliograph-search.service"
install -d "$STAGE/usr/share/doc/bibliograph-search"
gzip -9n -c packaging/search/changelog \
  > "$STAGE/usr/share/doc/bibliograph-search/changelog.Debian.gz"
chmod 0644 "$STAGE/usr/share/doc/bibliograph-search/changelog.Debian.gz"

find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod go-w {} +
chmod 0640 "$STAGE/etc/bibliograph/search.env"

size="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"

install -D -m 0755 packaging/search/debian/postinst "$DEBIAN_DIR/postinst"
install -D -m 0755 packaging/search/debian/prerm "$DEBIAN_DIR/prerm"
install -D -m 0644 packaging/search/debian/conffiles "$DEBIAN_DIR/conffiles"
sed -e "s/@VERSION@/${VERSION}-${REVISION}/" \
    -e "s/@ARCH@/${ARCH}/" \
    -e "s/@SIZE@/${size}/" \
    packaging/search/debian/control > "$DEBIAN_DIR/control"
chmod 0644 "$DEBIAN_DIR/control"

[[ -x "$STAGE$LIVE/bibliograph-search" ]] || die "payload lost the binary"
[[ -f "$UNIT_DIR/bibliograph-search.service" ]] || die "payload lost the unit"

say "Building the package"
install -d dist
out="dist/bibliograph-search_${VERSION}-${REVISION}_${ARCH}.deb"
packaging/md5sums.sh "$STAGE"
dpkg-deb --root-owner-group --build "$STAGE" "$out" >/dev/null
rm -rf "$STAGE"

say "Built $out"
dpkg-deb --field "$out" Package Version Architecture Installed-Size Depends
ls -lh "$out"
