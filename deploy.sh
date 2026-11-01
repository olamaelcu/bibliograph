#!/usr/bin/env bash
# Deploy the newest built bibliograph .deb to a host and verify it.
#
# Usage:
#   ./deploy.sh                             newest dist/bibliograph_*.deb -> veve@lescayes
#   ./deploy.sh alice@server                another host
#   PKG=dist/bibliograph_0.1.3_amd64.deb ./deploy.sh
#   DEPLOY_HOST=alice@server ./deploy.sh    same as the positional argument
#
# No version is named anywhere in this file. The package is selected from dist/
# by version sort (the same rule platform's .mise/tasks/deploy-host uses) and
# the version it reports is read back from the package and from the host, so a
# release needs only a new debian/changelog entry plus `mise run package-deb`.
#
# Requires: ssh, scp, passwordless sudo on the target, curl and dpkg on both
# ends. Build first: `mise run package-deb`.
#
# Installing a .deb is not the same as provisioning the host. When the target
# also needs PostgreSQL, the application role/database, DATABASE_URL, the OAuth
# client id or the lexicon publish, use `mise run deploy-deb` instead.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST="${1:-${DEPLOY_HOST:-veve@lescayes}}"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ -z "${1:-}" ] && [ -z "${DEPLOY_HOST:-}" ]; then
  echo "Using default host $HOST (pass a host or set DEPLOY_HOST to override)"
fi

PKG="${PKG:-$(ls -1 dist/bibliograph_*.deb 2>/dev/null | sort -V | tail -1 || true)}"
if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  die "no .deb in dist/; run 'mise run package-deb' first"
fi

DEB_NAME="$(basename "$PKG")"
DEB_VERSION="$(dpkg-deb -f "$PKG" Version)"
DEB_ARCH="$(dpkg-deb -f "$PKG" Architecture)"
DEB_SHA="$(sha256sum "$PKG" | cut -d' ' -f1)"
REMOTE_DEB="/tmp/$DEB_NAME"

say "Target $HOST"
say "Package $DEB_NAME (version $DEB_VERSION, $DEB_ARCH)"
say "Pipeline $PKG -> checksum ${DEB_SHA:0:12}..."

say "Preflight: ssh and passwordless sudo"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'sudo -n true' 2>/dev/null \
  || die "cannot reach $HOST with passwordless sudo (try: ssh -o BatchMode=yes $HOST 'sudo -n true')"

REMOTE_ARCH="$(ssh -o BatchMode=yes "$HOST" 'dpkg --print-architecture')"
if [ "$REMOTE_ARCH" != "$DEB_ARCH" ]; then
  die "architecture mismatch: package is $DEB_ARCH, host is $REMOTE_ARCH"
fi

say "Uploading $DEB_NAME"
scp -q "$PKG" "$HOST:$REMOTE_DEB"
REMOTE_SHA="$(ssh -o BatchMode=yes "$HOST" "sha256sum '$REMOTE_DEB' | cut -d' ' -f1")"
if [ "$REMOTE_SHA" != "$DEB_SHA" ]; then
  die "checksum mismatch after upload ($REMOTE_SHA != $DEB_SHA)"
fi

say "Installing and restarting on $HOST"
# Quoted heredoc plus positional arguments: every expansion below must run on
# the host. A $(...) inside a double-quoted ssh command would silently run on
# the deploying machine instead.
ssh -o BatchMode=yes "$HOST" "sudo -n bash -s -- '$DEB_NAME' '$DEB_VERSION'" <<'REMOTE'
set -euo pipefail
cd /

DEB="$1"
EXPECTED_VERSION="$2"
REMOTE_DEB="/tmp/$DEB"

export DEBIAN_FRONTEND=noninteractive

# --reinstall so re-deploying the same version still replaces the payload;
# --force-confold keeps local edits to the conffiles (bibliograph.env and the
# nginx site) rather than silently dropping them.
echo "    installing $DEB"
apt-get install -y -qq --reinstall \
  -o Dpkg::Options::=--force-confdef \
  -o Dpkg::Options::=--force-confold \
  "$REMOTE_DEB" >/dev/null
rm -f "$REMOTE_DEB" /etc/bibliograph/bibliograph.env.dpkg-dist

# The migrator is a oneshot pulled in by Requires= from the long-running units,
# so restarting the web unit re-runs it (that is how upgrades apply migrations).
# The worker and jobs units hold their own handles and need their own restart;
# they are optional so a host that does not run them still deploys.
echo "    restarting units"
systemctl restart bibliograph.service
systemctl restart bibliograph-worker.service >/dev/null 2>&1 || true
systemctl restart bibliograph-jobs.service >/dev/null 2>&1 || true

# The port is a debconf answer rendered into port.conf by the postinst, not a
# constant — read it rather than assuming 5000.
port=5000
if [ -f /etc/bibliograph/port.conf ]; then
  configured="$(sed -n 's/^PORT=//p' /etc/bibliograph/port.conf | head -1)"
  [ -n "$configured" ] && port="$configured"
fi

echo "    waiting for http://127.0.0.1:$port/"
code=000
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$port/" || true)"
  [ "$code" != "000" ] && break
  sleep 1
done

INSTALLED_VERSION="$(dpkg-query -W -f='${Version}' bibliograph 2>/dev/null || echo 'not installed')"
echo "INSTALLED_VERSION: $INSTALLED_VERSION"

fail=0
for unit in bibliograph bibliograph-worker bibliograph-jobs; do
  state="$(systemctl is-active "$unit" 2>&1 || true)"
  printf 'SERVICE_STATE: %-24s %s\n' "$unit" "$state"
  [ "$state" = active ] || fail=1
done
echo "HTTP: http://127.0.0.1:$port -> $code"

if [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "ERROR: installed version $INSTALLED_VERSION != package version $EXPECTED_VERSION" >&2
  exit 1
fi
if [ "$fail" -ne 0 ]; then
  echo "ERROR: a bibliograph unit is not active after the deploy" >&2
  exit 1
fi
echo SERVICE_OK
REMOTE

say "Deployed version $DEB_VERSION to $HOST"
cat <<'NEXT'

What the package cannot do for you:
  * TLS and the site: the vhost is staged at
    /etc/nginx/sites-available/bibliograph-platform and only symlinked into
    sites-enabled once its certificate exists:
      certbot certonly --webroot -w /var/www/html -d biblio.livtet.olamaelcu.net
      ln -s ../sites-available/bibliograph-platform /etc/nginx/sites-enabled/
      nginx -t && systemctl reload nginx
  * Secrets: ATP_SIGNING_KEY, ATP_LABEL_SIGNING_KEY, ATP_SERVICE_HOST,
    OAUTH_PUBLIC_ORIGIN, ADMIN_DIDS in /etc/bibliograph/bibliograph.env,
    then: systemctl restart bibliograph
  * TAP: TAP_URL and TAP_ADMIN_PASSWORD, otherwise the worker stops after 5
    attempts and the Postgres record cache (behind listShelves/getShelvingOfBook)
    stays empty — reads then fall back to per-request PDS scans.
NEXT
