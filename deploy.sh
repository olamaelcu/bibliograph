#!/usr/bin/env bash
# Deploy the four Bibliograph split packages to a host, dependency-first.
#
# Build (mise runs these before this script; see .mise/tasks/deploy):
#   package-hv-deb      -> dist/bibliograph-happyview_<version>_<arch>.deb
#   package-worker-deb  -> dist/bibliograph-worker_<version>_all.deb
#   package-search-deb  -> dist/bibliograph-search_<version>_amd64.deb
#   package-web-deb     -> dist/bibliograph-web_<version>_all.deb
#
# Install order, which is also the reason for it:
#   1. bibliograph-happyview  the activity plane and DB-init SQL; it is the
#                             upstream the edge proxies to.
#   2. bibliograph-worker     catalog schema SQL ships here and is applied next.
#   3. bibliograph-search     the loopback index the edge queries; its package
#                             ships the binary, the unit and the index
#                             directory (derived data, rebuilt by the backfill).
#   4. bibliograph-web        Depends: bibliograph-happyview and
#                             bibliograph-search; installed last so the public
#                             edge is never exposed before its upstream, the
#                             worker and the index exist.
#
# Database stages (all idempotent, none drops data):
#   * HappyView role/schema gate: DATABASE_URL in /etc/bibliograph/happyview.env
#     must connect, and the `happyview` schema (shared layout, created by
#     /usr/share/bibliograph-happyview/db-init.sql) or HappyView's migrated
#     tables (dedicated-database layout) must exist. db-init.sql is a one-time
#     superuser step with a password placeholder, so this script checks it
#     instead of running it with a guessable default.
#   * Catalog schema: every /usr/lib/bibliograph-worker/sql/*.sql file is
#     applied with psql against DATABASE_URL from /etc/bibliograph/worker.env.
#     The files are forward-only and safe to re-run (guarded backfills and
#     drops), but some of them migrate data and drop columns/tables, and they
#     are not reversible. Back up the database before deploying a release that
#     adds such a file.
#   * Feed read path: 0003-feed-read.sql is re-applied after HappyView has
#     migrated (its tables do not exist during the first catalog pass), so a
#     fresh host gets the feed indexes and grants without a second full pass.
#   * Bookhive import: after the worker restarts, `catalog.bookhive` is queued
#     as a one-off job (`job_key` `catalog.bookhive:deploy`, replaced on every
#     deploy). Its weekly cron is `0 3 * * 1`, so without this a fresh host has
#     no hive id -> edition join until the next Monday. Skip it with
#     `--skip-bookhive`; the walk is idempotent either way.
#
# Usage:
#   ./deploy.sh                          -> veve@lescayes.ts.olamaelcu.net
#   ./deploy.sh alice@server             another host
#   DEPLOY_HOST=alice@server ./deploy.sh
#   ./deploy.sh --dry-run                select and show the plan; no ssh
#   ./deploy.sh --print-remote           print the remote script; no ssh
#   ./deploy.sh --skip-db                DB already provisioned by another tool
#   ./deploy.sh --skip-nginx             do not validate/reload nginx
#   ./deploy.sh --skip-bookhive          do not queue the Bookhive import
#   DIST_DIR=some/dir ./deploy.sh        select debs from somewhere else
#
# Requires: ssh, scp, dpkg-deb and sha256sum locally; passwordless sudo,
# systemd, apt-get, dpkg, curl and (for the database stages) psql on the target.
# The retired combined `bibliograph` package is not selected or touched here.
#
# This is a fresh-start deployment: no data migration, no import, no seed.
# Staging, canary and rollback workflows are out of scope; rollback is a pin to
# an older package version (see docs/deploy/debian.md).
#
# Legacy hosts: the retired combined package conflicts with the split worker
# (both ship bibliograph-worker.service) and its nginx site owns the public
# name. Preflight detects it and aborts before uploading; --replace-legacy
# stops/purges it explicitly and requires the new vhost plus an HTTPS loopback
# check before reporting success.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST="${DEPLOY_HOST:-veve@lescayes.ts.olamaelcu.net}"
DIST_DIR="${DIST_DIR:-dist}"
DRY_RUN=0
PRINT_REMOTE=0
SKIP_DB=0
SKIP_NGINX=0
REPLACE_LEGACY=0
SKIP_BOOKHIVE=0

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

stage_env_hint() { # deb filename, env filename
  printf '  Stage the packaged conffile from the deb just built, then fill it in:\n'
  printf '    dpkg-deb -x dist/%s /tmp/bpkg-%s\n' "$1" "${2%%.*}"
  printf '    scp /tmp/bpkg-%s/etc/bibliograph/%s %s:/tmp/%s\n' "${2%%.*}" "$2" "$HOST" "$2"
  printf "    ssh %s 'sudo install -D -m 0640 -o root -g root /tmp/%s /etc/bibliograph/%s'\n" \
    "$HOST" "$2" "$2"
}

usage() {
  cat <<'EOF'
Usage: mise run deploy -- [HOST] [options]

Builds bibliograph-happyview, bibliograph-worker and bibliograph-web first (a
failed build aborts before any upload), then installs them on HOST in
dependency order with apt-get --reinstall. Stops at the first failed upload or
install.

HOST defaults to $DEPLOY_HOST or veve@lescayes.ts.olamaelcu.net.

Options:
  --dry-run       Select the packages and print the plan; no ssh, no upload.
  --print-remote  Print the remote install/verify script and exit.
  --replace-legacy
                  Stop and purge the retired combined `bibliograph` package and
                  remove its nginx site, then cut over to the split packages.
                  Explicit and destructive: purge drops the old package's
                  conffile edits (PostgreSQL data is NOT touched). Without this
                  flag, deploy aborts before uploading if the legacy package or
                  its sites-enabled/bibliograph-platform is present.
                  Requires, before upload: /etc/bibliograph/worker.env with a
                  valid DATABASE_URL, /etc/bibliograph/web.env with
                  HAPPYVIEW_URL (PORT optional), working nginx, and the vhost
                  certificate. Missing prerequisites abort without changing the
                  host; see docs/deploy/debian.md for staging commands.
  --skip-db       Skip the HappyView role/schema gate and the catalog schema
                  (use only when another tool owns the database).
  --skip-nginx    Skip nginx -t / reload after installing the web package.
  --skip-bookhive Skip queueing the Bookhive catalog import (it runs weekly
                  anyway; queued here so a fresh deploy has a hive id -> edition
                  join instead of waiting for the next Monday 03:00 cron).
  -h, --help      Show this help.

Environment:
  DEPLOY_HOST     ssh destination (also accepted as the first argument).
  DIST_DIR        directory holding the debs (default: dist).

Advanced: HV_PKG, WORKER_PKG and WEB_PKG pin an exact deb path instead of
selecting the newest one from DIST_DIR.

Examples:
  mise run deploy
  mise run deploy -- alice@server --dry-run
  mise run deploy -- --replace-legacy
  mise run deploy -- --skip-nginx
EOF
}

# The remote script is printed by --print-remote and piped to `sudo -n bash -s`.
# Arguments, in order:
#   1 happyview .deb name   2 its sha256
#   3 worker .deb name     4 its sha256
#   5 web .deb name        6 its sha256
#   7 skip database stages (0/1)   8 skip nginx (0/1)
#   9 replace the retired combined package (0/1)
remote_script() {
  cat <<'REMOTE'
set -euo pipefail
cd /

HV_DEB="/tmp/$1"
HV_SHA="$2"
WORKER_DEB="/tmp/$3"
WORKER_SHA="$4"
WEB_DEB="/tmp/$5"
WEB_SHA="$6"
SKIP_DB="$7"
SKIP_NGINX="$8"
REPLACE_LEGACY="${9:-0}"
SKIP_BOOKHIVE="${10:-0}"
SEARCH_DEB="${11:+/tmp/${11}}"
SEARCH_SHA="${12:-}"

export DEBIAN_FRONTEND=noninteractive

say()  { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for tool in apt-get dpkg-deb sha256sum systemctl curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required on the target"
done

cleanup() {
  rm -f "$HV_DEB" "$WORKER_DEB" "$WEB_DEB" \
        ${SEARCH_DEB:+"$SEARCH_DEB"} \
        /etc/bibliograph/happyview.env.dpkg-dist \
        /etc/bibliograph/worker.env.dpkg-dist \
        /etc/bibliograph/web.env.dpkg-dist 2>/dev/null || true
  # A catalog-schema replay runs with the readers stopped; if the deploy aborts
  # midway, bring them back instead of leaving the site down.
  if [ "${READERS_STOPPED:-0}" = 1 ]; then
    systemctl start happyview.service bibliograph-web.service >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

verify_upload() { # path sha
  local path="$1" sha="$2" got
  [ -f "$path" ] || fail "uploaded package '$path' is missing"
  got="$(sha256sum "$path" | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || fail "checksum mismatch for $path ($got != $sha); re-run deploy"
}

verify_upload "$HV_DEB" "$HV_SHA"
verify_upload "$WORKER_DEB" "$WORKER_SHA"
verify_upload "$WEB_DEB" "$WEB_SHA"
if [ -n "$SEARCH_DEB" ]; then
  verify_upload "$SEARCH_DEB" "$SEARCH_SHA"
fi

HV_VERSION="$(dpkg-deb -f "$HV_DEB" Version)"
WORKER_VERSION="$(dpkg-deb -f "$WORKER_DEB" Version)"
WEB_VERSION="$(dpkg-deb -f "$WEB_DEB" Version)"
[ "$(dpkg-deb -f "$HV_DEB" Package)" = bibliograph-happyview ] || fail "$HV_DEB is not bibliograph-happyview"
[ "$(dpkg-deb -f "$WORKER_DEB" Package)" = bibliograph-worker ] || fail "$WORKER_DEB is not bibliograph-worker"
[ "$(dpkg-deb -f "$WEB_DEB" Package)" = bibliograph-web ] || fail "$WEB_DEB is not bibliograph-web"
if [ -n "$SEARCH_DEB" ]; then
  [ "$(dpkg-deb -f "$SEARCH_DEB" Package)" = bibliograph-search ] || fail "$SEARCH_DEB is not bibliograph-search"
fi

apt_install() {
  local deb="$1"
  local pkg want tmp
  pkg="$(dpkg-deb -f "$deb" Package)"
  want="$(dpkg-deb -f "$deb" Version)"
  # Same version is not the same payload: this script rebuilds packages on
  # every run. Compare the deb's own md5sums with the installed package's and
  # let dpkg verify the files on disk; only then is a reinstall a no-op that
  # costs ~40s on the production disk (11% CPU, the rest IO) plus the
  # postinst's oneshot (76s for HappyView).
  if [ "$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)" = "$want" ]; then
    tmp="$(mktemp -d)"
    # `dpkg -V` is not the check here: it reports the locally edited conffiles
    # (/etc/bibliograph/*.env) and would make every deploy reinstall. The deb's
    # own `md5sums` list is the payload identity: same paths, same hashes.
    if dpkg-deb -e "$deb" "$tmp" 2>/dev/null \
       && cmp -s "$tmp/md5sums" "/var/lib/dpkg/info/$pkg.md5sums"; then
      note "$pkg $want unchanged (payload verified); skipping install"
      rm -rf "$tmp"
      return 0
    fi
    rm -rf "$tmp"
  fi
  say "Installing $(basename "$deb")"
  # --reinstall replaces an identical version's payload, so re-running deploy
  # is a real redeploy. confdef/confold keeps local edits to the env conffiles.
  apt-get install -y -qq --reinstall \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$deb" || fail "apt-get install failed for $(basename "$deb")"
}

verify_version() { # package expected
  local pkg="$1" want="$2" got
  got="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || echo missing)"
  [ "$got" = "$want" ] \
    || fail "$pkg installed version '$got' != package version '$want'"
  printf 'PKG_VERSION %s %s\n' "$pkg" "$got"
}

env_value() { # file key -> last non-empty uncommented value
  local file="$1" key="$2" value=""
  [ -r "$file" ] || { printf ''; return 0; }
  value="$(sed -n "s/^${key}=//p" "$file" | tail -1)"
  case "$value" in
    \"*\"|\\'*\\') value="${value#?}"; value="${value%?}" ;;
  esac
  printf '%s' "$value"
}

combined_env_value() { # key file...
  local key="$1" value="" v file
  shift
  for file in "$@"; do
    v="$(env_value "$file" "$key")"
    [ -n "$v" ] && value="$v"
  done
  printf '%s' "$value"
}

db_name_from_url() { # URL -> database name for the db-init message
  local url="$1" db
  db="${url##*/}"
  db="${db%%\?*}"
  db="${db%%#*}"
  printf '%s' "$db"
}

# ------------------------------------------------ legacy detection ---
# The retired combined package ships the same bibliograph-worker.service path
# as the split worker, and its nginx site owns the same :443 server_name. Both
# must be gone before the split packages can take over.
legacy_pkg_status="$(dpkg-query -W -f='${Status}' bibliograph 2>/dev/null || true)"
[ -n "$legacy_pkg_status" ] || legacy_pkg_status=absent
legacy_pkg_version="$(dpkg-query -W -f='${Version}' bibliograph 2>/dev/null || true)"
[ -n "$legacy_pkg_version" ] || legacy_pkg_version=none
legacy_service="$(systemctl is-active bibliograph.service 2>/dev/null || true)"
legacy_worker_service="$(systemctl is-active bibliograph-worker.service 2>/dev/null || true)"
legacy_site_enabled=no
if [ -e /etc/nginx/sites-enabled/bibliograph-platform ] \
   || [ -L /etc/nginx/sites-enabled/bibliograph-platform ]; then
  legacy_site_enabled=yes
fi
legacy_present=0
case "$legacy_pkg_status" in
  ''|absent|*not-installed*) : ;;
  *) legacy_present=1 ;;
esac
[ "$legacy_service" = active ] && legacy_present=1
[ "$legacy_site_enabled" = yes ] && legacy_present=1

printf 'LEGACY package=%s version=%s service=%s worker=%s site=%s\n' \
  "$legacy_pkg_status" "$legacy_pkg_version" "$legacy_service" \
  "$legacy_worker_service" "$legacy_site_enabled"

if [ "$legacy_present" = 1 ] && [ "$REPLACE_LEGACY" = 0 ]; then
  fail "the retired combined package/site is present (package=$legacy_pkg_status, service=$legacy_service, site=$legacy_site_enabled). Re-run with --replace-legacy to cut over."
fi

# The local preflight checks these before uploading; repeat them before any
# install so a changed target cannot be purged with no replacement ready.
if [ "$REPLACE_LEGACY" = 1 ]; then
  [ -r /etc/bibliograph/worker.env ] \
    || fail "/etc/bibliograph/worker.env is missing; stage and fill it before a cutover (docs/deploy/debian.md)"
  worker_check_url="$(env_value /etc/bibliograph/worker.env DATABASE_URL)"
  case "$worker_check_url" in
    postgres://?*|postgresql://?*) ;;
    *) fail "/etc/bibliograph/worker.env has no valid DATABASE_URL; set one before a cutover" ;;
  esac
  [ -r /etc/bibliograph/web.env ] \
    || fail "/etc/bibliograph/web.env is missing; stage and fill it before a cutover (docs/deploy/debian.md)"
  web_check_hv="$(env_value /etc/bibliograph/web.env HAPPYVIEW_URL)"
  case "$web_check_hv" in
    http://?*|https://?*) ;;
    *) fail "/etc/bibliograph/web.env has no valid HAPPYVIEW_URL; set one before a cutover" ;;
  esac
  web_check_port="$(env_value /etc/bibliograph/web.env PORT)"
  if [ -n "$web_check_port" ]; then
    case "$web_check_port" in
      *[!0-9]*) fail "/etc/bibliograph/web.env has an invalid PORT; set 1-65535" ;;
      *) [ "$web_check_port" -ge 1 ] 2>/dev/null && [ "$web_check_port" -le 65535 ] 2>/dev/null \
           || fail "/etc/bibliograph/web.env PORT is out of range" ;;
    esac
  fi
  command -v nginx >/dev/null 2>&1 || fail "nginx is required for a cutover"
  nginx -t >/dev/null 2>&1 || fail "nginx -t fails; fix the existing configuration before a cutover"
  cert_check=""
  if [ -f /etc/nginx/sites-available/bibliograph-web ]; then
    cert_check="$(awk '/^[[:space:]]*ssl_certificate[[:space:]]/ {print $2; exit}' \
      /etc/nginx/sites-available/bibliograph-web 2>/dev/null || true)"
    cert_check="${cert_check%;}"
  fi
  [ -n "$cert_check" ] || cert_check=/etc/letsencrypt/live/biblio.livtet.olamaelcu.net/fullchain.pem
  [ -f "$cert_check" ] \
    || fail "the vhost certificate is missing at $cert_check; obtain it before a cutover"
fi

# --------------------------------------------------- 1. HappyView (upstream) ---

apt_install "$HV_DEB"
verify_version bibliograph-happyview "$HV_VERSION"

if [ "$SKIP_DB" = 0 ]; then
  command -v psql >/dev/null 2>&1 \
    || fail "psql is missing on the target although bibliograph-happyview Depends: postgresql-client; repair the install (apt-get install -y postgresql-client)"

  hv_url="$(combined_env_value DATABASE_URL \
    /etc/bibliograph/happyview.env /etc/bibliograph/happyview.local)"
  [ -n "$hv_url" ] \
    || fail "DATABASE_URL is empty in /etc/bibliograph/happyview.env.
  Create the HappyView role and schema once as a Postgres superuser:
    sudo -u postgres psql -v db=<database> -f /usr/share/bibliograph-happyview/db-init.sql
  (the file ships in bibliograph-happyview; change its password placeholder first)
  then set DATABASE_URL=postgres://happyview_app:<password>@<host>/<database>
  in /etc/bibliograph/happyview.env and re-run 'mise run deploy'.
  This script never runs a role creation with a guessed password."

  hv_state="$(PGOPTIONS='-c client_min_messages=warning' \
    psql "$hv_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -tAc \
      "SELECT (to_regnamespace('happyview') IS NOT NULL OR to_regclass('public.happyview_records') IS NOT NULL)::int" 2>&1)" \
    || fail "cannot query the HappyView database with DATABASE_URL from happyview.env:
$hv_state"

  hv_state="$(printf '%s' "$hv_state" | tr -d '[:space:]')"
  if [ "$hv_state" != 1 ]; then
    db_name="$(db_name_from_url "$hv_url")"
    fail "the HappyView database is not provisioned (DATABASE_URL connects, but neither the 'happyview' schema nor public.happyview_records exists).
  Shared-database layout -- run once as a Postgres superuser (the SQL ships in
  the installed package):
    sudo -u postgres psql -v db=${db_name:-<database>} -f /usr/share/bibliograph-happyview/db-init.sql
  Dedicated-database layout -- create the role and database, leave the role's
  search_path alone, and start happyview once so it migrates.
  Then re-run 'mise run deploy'. The catalog schema is applied later, and the
  role gets SELECT on catalog tables when the catalog schema runs."
  fi
  note "HappyView database ok"
else
  note "--skip-db: HappyView role/schema gate skipped"
fi

# ------------------------------------------ legacy cutover (explicit) ---
if [ "$REPLACE_LEGACY" = 1 ]; then
  if [ "$legacy_present" = 1 ]; then
    say "Cutting over from the retired combined package"
    systemctl disable --now bibliograph.service 2>/dev/null || true
    systemctl disable --now bibliograph-worker.service 2>/dev/null || true
    # Remove the enabled site first: dpkg purge owns only sites-available, so a
    # leftover symlink would keep nginx loading a vhost whose file is gone.
    rm -f /etc/nginx/sites-enabled/bibliograph-platform

    # Purge BEFORE installing the split worker: both packages ship
    # /usr/lib/systemd/system/bibliograph-worker.service. Installing first
    # would make dpkg refuse the overwrite, and purging afterwards would delete
    # the newly installed unit.
    if dpkg-query -W bibliograph >/dev/null 2>&1; then
      say "Purging the retired bibliograph package"
      apt-get purge -y bibliograph \
        || fail "apt-get purge bibliograph failed; the cutover is incomplete"
    fi
    systemctl daemon-reload

    legacy_available=/etc/nginx/sites-available/bibliograph-platform
    if [ -e "$legacy_available" ] || [ -L "$legacy_available" ]; then
      legacy_owner="$(dpkg -S "$legacy_available" 2>/dev/null || true)"
      [ -z "$legacy_owner" ] \
        || fail "$legacy_available is still owned by '$legacy_owner' after purge; remove that package before continuing"
      rm -f "$legacy_available"
    fi

    if command -v nginx >/dev/null 2>&1; then
      nginx -t >/dev/null 2>&1 || { nginx -t >&2 || true; fail "nginx -t failed after removing the legacy site"; }
      systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null \
        || fail "could not reload nginx after removing the legacy site"
    fi
    note "legacy package purged and its nginx site removed"
  else
    note "--replace-legacy: no legacy install/site found; nothing purged"
  fi
fi

# ----------------------------------------------------- 2. Worker (+ schema) ---

apt_install "$WORKER_DEB"
# The postinst already restarted it; stop it so a fresh database is not hit by
# a worker whose catalog tables are applied a few seconds later. It is started
# again in the ordered restart below.
systemctl stop bibliograph-worker.service >/dev/null 2>&1 || true
# A stop that hits systemd's timeout leaves the unit `failed` even though the
# deploy meant to stop it; clear that state so the verification reads it as
# scheduled-off rather than broken.
systemctl reset-failed bibliograph-worker.service >/dev/null 2>&1 || true
verify_version bibliograph-worker "$WORKER_VERSION"

if [ "$SKIP_DB" = 0 ]; then
  worker_url="$(combined_env_value DATABASE_URL /etc/bibliograph/worker.env)"
  [ -n "$worker_url" ] \
    || fail "DATABASE_URL is empty in /etc/bibliograph/worker.env.
  Create the role and database once, then set DATABASE_URL and re-run:
    sudo -u postgres createuser --pwprompt bibliograph
    sudo -u postgres createdb -O bibliograph bibliograph
  See docs/operations/fresh-database.md."
  # A stop that outlives graphile's abort window (or a kill) leaves the job row
  # and its queue row locked, and graphile only clears locks older than four
  # hours: the `pds-publish` queue stays unavailable and the outbox grows while
  # nothing publishes. The packaged unit now clears these itself at boot
  # (`WORKER_CLEAR_STALE_LOCKS=1`), so this is the belt for hosts still running
  # an older worker and for a stop that happens between the install and the
  # first start. This host runs one worker and it is stopped right now, so no
  # lock can be legitimately held. A fresh database has no graphile schema yet;
  # that is not an error.
  psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -c "
    UPDATE graphile_worker._private_jobs
       SET locked_at = NULL, locked_by = NULL, run_at = greatest(run_at, now())
     WHERE locked_at IS NOT NULL;
    UPDATE graphile_worker._private_job_queues
       SET locked_at = NULL, locked_by = NULL
     WHERE locked_at IS NOT NULL;" \
    && note "Worker job locks cleared (a stop leaves in-flight jobs locked for four hours)" \
    || note "graphile_worker locks not cleared (no schema yet); continuing"

  sql_dir=/usr/lib/bibliograph-worker/sql
  [ -d "$sql_dir" ] \
    || fail "the installed bibliograph-worker has no $sql_dir; rebuild it with 'mise run package-worker-deb'"
  mapfile -t sql_files < <(find "$sql_dir" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
  [ "${#sql_files[@]}" -gt 0 ] \
    || fail "no *.sql files in $sql_dir; the worker package is incomplete"

  psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" \
    || fail "could not create schema_migrations; the deploy needs a writable catalog database"

  # A migration takes AccessExclusiveLock on the relations it recreates
  # (`CREATE OR REPLACE VIEW` included), while HappyView and the edge keep
  # reading them. Under traffic the two sides deadlock in a cycle that a retry
  # cannot break — measured twice while replaying 0007/0013 against a live
  # catalogue — so the readers are stopped for the replay; the ordered restarts
  # below bring both back. `lock_timeout` still makes a lock wait fail fast
  # instead of parking the transaction while it holds other relations.
  READERS_STOPPED=1
  for unit in bibliograph-web.service happyview.service; do
    if systemctl is-active --quiet "$unit"; then
      say "Stopping $unit for the catalog schema replay"
      systemctl stop "$unit" || true
    fi
  done

  for file in "${sql_files[@]}"; do
    name=$(basename "$file")
    # The ledger is what keeps a deploy short: the files are forward-only, so
    # re-applying all 37 on every release re-ran the data migrations (0011's
    # language UPDATE measured 31s, 0015 the whole shape table) for no change.
    # A file that is edited after being applied does not re-run by design; add a
    # new numbered file instead. 0003/0020 are still re-applied explicitly below.
    if [ -n "$(psql "$worker_url" -X -q -tA --no-psqlrc -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")" ]; then
      note "Catalog schema: $name (already applied)"
      continue
    fi
    say "Catalog schema: $name (new)"
    attempt=1
    while :; do
      if output=$(PGOPTIONS='-c lock_timeout=15000' psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -f "$file" 2>&1); then
        break
      fi
      case "$output" in
        *"deadlock detected"*|*"could not obtain lock"*|*"canceling statement due to lock timeout"*)
          if [ "$attempt" -lt 3 ]; then
            note "lock conflict applying $(basename "$file") (attempt $attempt/3); retrying in 5s"
            attempt=$((attempt + 1))
            sleep 5
            continue
          fi
          ;;
      esac
      printf '%s\n' "$output"
      fail "catalog schema failed at $(basename "$file"). Each file is one transaction, so this one was rolled back; earlier files in this run stay applied. Data migrated by an earlier file is not reverted. Fix the error and re-run (the files are re-runnable)."
    done
    psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc \
      -c "INSERT INTO schema_migrations (filename) VALUES ('$name') ON CONFLICT DO NOTHING" \
      || fail "could not record $name in schema_migrations; it will be re-applied next deploy"
  done
  note "Catalog schema applied (forward-only; applied files are skipped)"
  READERS_STOPPED=0
else
  note "--skip-db: catalog schema skipped"
fi

# ------------------------------------------------ 3. Web edge (last, edge) ---

if [ -n "$SEARCH_DEB" ]; then
  # Before web: bibliograph-web Depends: bibliograph-search.
  apt_install "$SEARCH_DEB"
fi
apt_install "$WEB_DEB"
verify_version bibliograph-web "$WEB_VERSION"

# On an explicit cutover the replacement is only complete when the new vhost is
# enabled. The postinst normally enables it at install time (the legacy symlink
# is already gone), but re-run it if it staged the site for any reason.
if [ "$REPLACE_LEGACY" = 1 ]; then
  web_site_enabled=/etc/nginx/sites-enabled/bibliograph-web
  if [ ! -e "$web_site_enabled" ] && [ ! -L "$web_site_enabled" ]; then
    say "Re-running the bibliograph-web postinst to enable its vhost"
    dpkg-reconfigure -f noninteractive bibliograph-web \
      || fail "dpkg-reconfigure bibliograph-web failed"
  fi
  if [ ! -e "$web_site_enabled" ] && [ ! -L "$web_site_enabled" ]; then
    fail "the legacy site is gone but $web_site_enabled is still absent, so nothing serves the public name. bibliograph-web stages its vhost until a certificate exists for its server_name; obtain the certificate and re-run, or enable it manually:
    ln -s ../sites-available/bibliograph-web $web_site_enabled
    nginx -t && systemctl reload nginx"
  fi
  note "new web vhost enabled"
fi

# --------------------------------------------------------- units in order ---

restart_unit() {
  local unit="$1" state
  say "systemctl restart $unit"
  # The worker is deliberately not enabled at boot: its window timer owns when
  # it runs (see the restart below). Enabling it here would bring it back
  # outside the window on the next boot.
  if [ "$unit" != bibliograph-worker.service ] \
     || ! systemctl is-enabled --quiet bibliograph-worker-window.timer 2>/dev/null; then
    systemctl enable "$unit" >/dev/null 2>&1 || true
  fi
  systemctl restart "$unit" || {
    state="$(systemctl is-active "$unit" 2>&1 || true)"
    note "unit is $state"
    journalctl -u "$unit" -n 30 --no-pager >&2 2>/dev/null || true
    fail "restart failed for $unit"
  }
}

# The client seed is ordered Before=happyview at boot, and HappyView loads its
# client registry into memory at start, so seed first and then start HappyView.
restart_unit bibliograph-happyview-client.service
restart_unit happyview.service
# PartOf=happyview restarts this oneshot with HappyView; restart it explicitly
# so the deploy finishes only after the lexicons/scripts/indexes succeeded.
restart_unit bibliograph-happyview-deploy.service

# 0003 reads `happyview.happyview_records`, which HappyView creates from its
# own migrations. The catalog pass above runs before HappyView starts, so on a
# fresh host it skipped its indexes and grants. Re-apply only that file now
# that HappyView has migrated and `hv-deploy --wait` has confirmed readiness;
# re-running the whole catalog schema would be unnecessary. Fatal on error:
# without the indexes/grants the edge feed generator answers 503.
if [ "$SKIP_DB" = 0 ]; then
  worker_url="$(combined_env_value DATABASE_URL /etc/bibliograph/worker.env)"
  [ -n "$worker_url" ] \
    || fail "DATABASE_URL is empty in /etc/bibliograph/worker.env; cannot apply the feed read path"
  sql_dir=/usr/lib/bibliograph-worker/sql
  for feed_file in 0003-feed-read.sql 0020-feed-popfeed.sql; do
    feed_sql="$sql_dir/$feed_file"
    [ -f "$feed_sql" ] \
      || fail "the installed bibliograph-worker has no $feed_sql; rebuild it with 'mise run package-worker-deb'"
    say "Feed read path: re-applying $feed_file after HappyView migrated"
    psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -f "$feed_sql" \
      || fail "feed read schema failed at $feed_file; the edge feed generator answers 503 without it. Fix the grant/index error and re-run (idempotent)."
  done
  note "Feed read path applied (indexes and grants only; idempotent)"
else
  note "--skip-db: feed read schema re-apply skipped"
fi

# The worker runs only inside its daily window (01:00–08:00 America/New_York,
# enforced by bibliograph-worker-window.timer). Outside it the timer starts the
# worker, so a deploy must not: restarting here would put hydration and
# publishing back on the database during the edge's busy hours.
if systemctl is-enabled --quiet bibliograph-worker-window.timer 2>/dev/null; then
  if systemctl is-active --quiet bibliograph-worker.service; then
    restart_unit bibliograph-worker.service
  else
    note "bibliograph-worker.service is outside its window; the timer starts it at 01:00 ET"
  fi
else
  restart_unit bibliograph-worker.service
fi

# Queue the Bookhive catalog import. Without it the weekly cron would wait for
# the next Monday 03:00, and until it runs no Bookhive `hiveId` names an edition:
# those records are neither reviews nor linkable feed entries. The walk is
# idempotent (identifier set *and* claims are compared per book), so a re-deploy
# replaces the pending job and the second run mostly skips.
if [ "$SKIP_DB" = 0 ] && [ "$SKIP_BOOKHIVE" = 0 ]; then
  worker_url="$(combined_env_value DATABASE_URL /etc/bibliograph/worker.env)"
  [ -n "$worker_url" ] \
    || fail "DATABASE_URL is empty in /etc/bibliograph/worker.env; cannot queue the Bookhive import"
  say "Queueing the Bookhive catalog import (catalog.bookhive:deploy)"
  # `add_job` is graphile's public enqueue function; job_key + replace makes a
  # repeated deploy idempotent instead of stacking copies of the walk.
  psql "$worker_url" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -c "
    SELECT graphile_worker.add_job(
      'catalog.bookhive',
      json_build_object('pages', 5000)::json,
      queue_name => 'bookhive',
      max_attempts => 2,
      job_key => 'catalog.bookhive:deploy',
      job_key_mode => 'replace'
    );" >/dev/null \
    || fail "could not queue catalog.bookhive; the worker is up but the import was not queued"
  note "queued; the worker walks Bookhive's catalog in the background (5000 pages at most)"
elif [ "$SKIP_BOOKHIVE" = 1 ]; then
  note "--skip-bookhive: Bookhive import not queued (the Monday cron still runs it)"
else
  note "--skip-db: Bookhive import not queued"
fi

restart_unit bibliograph-web.service

# The web unit and the packaged nginx vhost must agree on the port, or nginx
# answers 502 while the loopback check below still passes.
port="$(env_value /etc/bibliograph/web.env PORT)"
port="${port:-5176}"

# --------------------------------------------------------------- nginx ---

if [ "$SKIP_NGINX" = 1 ]; then
  echo "NGINX skipped (--skip-nginx)"
elif command -v nginx >/dev/null 2>&1; then
  site=/etc/nginx/sites-available/bibliograph-web
  if [ -f "$site" ]; then
    site_port="$(sed -n 's/.*server 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$site" | head -1)"
    if [ -n "$site_port" ] && [ "$site_port" != "$port" ]; then
      note "WARNING: $site proxies to 127.0.0.1:$site_port but web.env PORT=$port; nginx would answer 502"
    fi
  fi
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t >&2 || true
    fail "nginx -t failed after installing bibliograph-web; fix the site before the edge can be reachable"
  fi
  systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null \
    || fail "could not reload or restart nginx"
  if [ -e /etc/nginx/sites-enabled/bibliograph-web ] \
     || [ -L /etc/nginx/sites-enabled/bibliograph-web ]; then
    echo "NGINX ok (site enabled)"
  else
    echo "NGINX ok (vhost staged, not enabled: certificate missing or old site still enabled)"
  fi
else
  echo "NGINX absent (bibliograph-web is only reachable on 127.0.0.1; install nginx to front it)"
fi

# --------------------------------------------------------------- lexicons ---

# The permission set and every other app lexicon are `com.atproto.lexicon.schema`
# records on the publisher's repo, and nothing else writes them: `hv-deploy`
# registers lexicons with HappyView for dispatch, which is a different store. A
# manual `mise run publish-lex` is what let `authLivtetCore` drift two collections
# behind this tree, so the release publishes here and a stale record can no longer
# ship silently.
# Only `net.olamaelcu.livtet.biblio.*` is published: the other records in the
# tree (`authLivtetCore`) belong to the Livtet app repo's tree and its own
# release, so this deploy must not write or delete them.
lexicons_dir=/usr/lib/bibliograph-happyview/lexicons
publisher=/usr/lib/bibliograph-happyview/bin/publish-lexicons.mjs
pds_url="$(env_value /etc/bibliograph/worker.env PDS_URL)"
pds_did="$(env_value /etc/bibliograph/worker.env PDS_ACCOUNT_DID)"
pds_password="$(env_value /etc/bibliograph/worker.env PDS_ACCOUNT_PASSWORD)"
pds_token=""
[ -n "$pds_password" ] || pds_token="$(env_value /etc/bibliograph/worker.env PDS_ACCESS_TOKEN)"

if [ -z "$pds_url" ] || [ -z "$pds_did" ] || { [ -z "$pds_password" ] && [ -z "$pds_token" ]; }; then
  echo "WARNING: worker.env has no publisher credentials; lexicons were not published" >&2
elif ! command -v node >/dev/null 2>&1; then
  # node arrives with the worker package; a host with credentials but no node
  # cannot keep the records current, and silently skipping would recreate the
  # drift this step exists to prevent.
  fail "publisher credentials are configured but node is absent; lexicons cannot be published"
elif [ ! -f "$publisher" ] || [ ! -d "$lexicons_dir" ]; then
  fail "$publisher or $lexicons_dir is missing; the package did not carry them"
else
  printf 'LEXICONS publishing to %s\n' "$pds_url"
  # Assigned as command-prefix variables so the secret reaches node's environment
  # without appearing in any argv, and never echoed.
  if [ -n "$pds_password" ]; then
    PDS_URL="$pds_url" PDS_ACCOUNT_DID="$pds_did" PDS_ACCOUNT_PASSWORD="$pds_password" \
      node "$publisher" --dir "$lexicons_dir" --only net.olamaelcu.livtet.biblio ||
      fail "the lexicon publish failed; the permission-set record is stale"
  else
    PDS_URL="$pds_url" PDS_ACCOUNT_DID="$pds_did" PDS_ACCESS_TOKEN="$pds_token" \
      node "$publisher" --dir "$lexicons_dir" --only net.olamaelcu.livtet.biblio ||
      fail "the lexicon publish failed; the permission-set record is stale"
  fi
  printf 'LEXICONS published\n'
fi

# ----------------------------------------------------------- verification ---

code=000
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$port/" || true)"
  [ "$code" != 000 ] && break
  sleep 1
done
printf 'HTTP http://127.0.0.1:%s/ %s\n' "$port" "$code"

# A cutover is only complete when the public name actually answers through the
# new vhost. Fresh installs may legitimately stage the vhost until a certificate
# exists, so this is fatal only in --replace-legacy mode.
web_site_enabled=/etc/nginx/sites-enabled/bibliograph-web
if [ -e "$web_site_enabled" ] || [ -L "$web_site_enabled" ]; then
  # nginx writes `server_name host;`, so $2 includes the trailing semicolon;
  # strip it before building the --resolve host:port and https:// URL.
  vhost_name="$(awk '/^[[:space:]]*server_name[[:space:]]/ {gsub(/;$/,"",$2); print $2; exit}' \
    /etc/nginx/sites-available/bibliograph-web 2>/dev/null || true)"
  if [ -z "$vhost_name" ] || [ "$vhost_name" = _ ]; then
    if [ "$REPLACE_LEGACY" = 1 ]; then
      fail "$web_site_enabled is enabled but its server_name cannot be read from /etc/nginx/sites-available/bibliograph-web; the cutover is incomplete"
    fi
  else
    https_code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      --resolve "$vhost_name:443:127.0.0.1" "https://$vhost_name/" || true)"
    printf 'HTTPS https://%s/ %s\n' "$vhost_name" "$https_code"
    if [ "$REPLACE_LEGACY" = 1 ] && [ "$https_code" != 200 ]; then
      fail "the new vhost is enabled but https://$vhost_name/ (via loopback) answered $https_code; the cutover is incomplete"
    fi
  fi
fi

xrpc_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
  -X POST -H 'content-type: application/json' \
  --data '{"q":"deploy probe","limit":1}' \
  "http://127.0.0.1:$port/xrpc/community.lexicon.media.book.searchEditions" || true)"
printf 'XRPC searchEditions %s\n' "$xrpc_code"

search_port="$(sed -n 's/^SEARCH_BIND=.*:\([0-9][0-9]*\)$/\1/p' \
  /etc/bibliograph/search.env 2>/dev/null | tail -1)"
: "${search_port:=3103}"
search_health="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
  "http://127.0.0.1:$search_port/healthz" || true)"
printf 'SEARCH healthz %s\n' "$search_health"

bad=0
for unit in bibliograph-happyview-client.service happyview.service \
            bibliograph-happyview-deploy.service bibliograph-worker.service \
            bibliograph-web.service bibliograph-search.service; do
  state="$(systemctl is-active "$unit" 2>&1 || true)"
  if [ "$unit" = bibliograph-worker.service ] && [ "$state" != active ] \
     && systemctl is-enabled --quiet bibliograph-worker-window.timer 2>/dev/null; then
    # Scheduled off, not broken: the window timer starts it at 01:00 ET.
    printf 'SERVICE_STATE %-40s %s\n' "$unit" "$state (scheduled window)"
  else
    printf 'SERVICE_STATE %-40s %s\n' "$unit" "$state"
    if [ "$state" != active ]; then
      bad=1
      journalctl -u "$unit" -n 30 --no-pager >&2 2>/dev/null || true
    fi
  fi
done

if [ "$search_health" != 200 ]; then
  # The edge falls back to Postgres, but a deploy that leaves the index down is
  # not a successful deploy.
  printf 'ERROR: bibliograph-search /healthz answered %s\n' "$search_health" >&2
  bad=1
fi
if [ "$code" != 200 ]; then
  fail "the web edge did not answer 200 on http://127.0.0.1:$port/ (got $code)"
fi
if [ "$bad" -ne 0 ]; then
  fail "one or more units are not active; see the journal lines above"
fi

echo "DEPLOY_OK"
REMOTE
}

# ------------------------------------------------------------------ packages ---

select_deb() { # $1 = package name, $2 = mise task, $3 = explicit-path variable
  local matches
  local var="$3"
  local explicit="${!var:-}"
  if [ -n "$explicit" ]; then
    [ -f "$explicit" ] || die "$var=$explicit does not exist"
    printf '%s\n' "$explicit"
    return 0
  fi
  matches="$(compgen -G "$DIST_DIR/$1_*.deb" || true)"
  [ -n "$matches" ] || die "no $1 package in $DIST_DIR/ (run 'mise run $2')"
  printf '%s\n' "$matches" | sort -V | tail -1
}

print_plan() {
  if [ "$REPLACE_LEGACY" = 1 ]; then
    legacy_plan="  --replace-legacy is set. Before uploading, preflight requires a staged
  /etc/bibliograph/worker.env with a valid DATABASE_URL, a staged
  /etc/bibliograph/web.env with HAPPYVIEW_URL (PORT optional, default 5176),
  working nginx, and the vhost certificate; any failure aborts without touching
  the old package/site. After happyview and the DB gate: stop/disable
  bibliograph.service and bibliograph-worker.service; remove the legacy
  sites-enabled symlink; purge bibliograph; remove its sites-available file if
  no installed package owns it; daemon-reload and reload nginx. Then install
  worker -> schema -> web. The purge is before the worker install because both
  packages ship /usr/lib/systemd/system/bibliograph-worker.service. Afterwards
  sites-enabled/bibliograph-web and an HTTPS loopback check are required."
  else
    legacy_plan="  If dpkg-query finds bibliograph, bibliograph.service is active, or
  sites-enabled/bibliograph-platform exists (symlink included), deploy aborts
  before uploading. Re-run with --replace-legacy to cut over."
  fi
  cat <<EOF
Target: $HOST

Build (.mise/tasks/deploy, sequential; all must succeed before this script runs):
  1. mise run package-web-deb     -> $WEB_NAME ($WEB_VERSION, $WEB_ARCH)   [first]
  2. mise run package-hv-deb      -> $HV_NAME ($HV_VERSION, $HV_ARCH)
  3. mise run package-search-deb  -> $SEARCH_NAME ($SEARCH_VERSION, $SEARCH_ARCH)
  4. mise run package-worker-deb  -> $WORKER_NAME ($WORKER_VERSION, $WORKER_ARCH)   [last: prunes web dev links]

Install (dependency-first, apt-get --reinstall, stop on failure):
  1. bibliograph-happyview  upstream activity plane + db-init.sql
  2. bibliograph-worker     catalog schema SQL at /usr/lib/bibliograph-worker/sql/
  3. bibliograph-search     loopback index (Depends: adduser); empty until the backfill
  4. bibliograph-web        Depends: bibliograph-happyview, bibliograph-search; edge last

Database stages:
  * HappyView role/schema gate after step 1 (db-init.sql is a one-time
    superuser step; this script never invents a password)
  * catalog schema after step 2 (forward-only: numbered files may migrate data
    and drop columns/tables; each file is one transaction, re-running is safe,
    and the drops are not reversible)

Legacy detection (host preflight):
  dpkg-query -W bibliograph; systemctl is-active bibliograph.service;
  /etc/nginx/sites-enabled/bibliograph-platform (symlink included).
$legacy_plan

Then: restart bibliograph-happyview-client -> happyview ->
      bibliograph-happyview-deploy -> bibliograph-worker -> bibliograph-web;
      validate/reload nginx if installed; verify versions, unit states,
      loopback HTTP on the port from /etc/bibliograph/web.env (default 5176),
      and best-effort XRPC.
EOF
}

# --------------------------------------------------------------- arguments ---

while (($# > 0)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --print-remote) PRINT_REMOTE=1 ;;
    --replace-legacy) REPLACE_LEGACY=1 ;;
    --skip-db) SKIP_DB=1 ;;
    --skip-nginx) SKIP_NGINX=1 ;;
    --skip-bookhive) SKIP_BOOKHIVE=1 ;;
    --) shift; break ;;
    -*) die "unknown option '$1' (try --help)" ;;
    *)
      [ "$HOST" = "${DEPLOY_HOST:-veve@lescayes.ts.olamaelcu.net}" ] \
        || die "more than one host given ('$HOST' and '$1')"
      HOST="$1"
      ;;
  esac
  shift
done

if (($# > 0)); then
  [ "$HOST" = "${DEPLOY_HOST:-veve@lescayes.ts.olamaelcu.net}" ] \
    || die "more than one host given ('$HOST' and '$1')"
  HOST="$1"
  shift
fi
(($# == 0)) || die "unexpected argument '$1' (try --help)"

if [ "$PRINT_REMOTE" = 1 ]; then
  remote_script
  exit 0
fi

for tool in dpkg-deb sha256sum; do
  command -v "$tool" >/dev/null || die "$tool is required locally"
done

HV_DEB="$(select_deb bibliograph-happyview package-hv-deb HV_PKG)"
WORKER_DEB="$(select_deb bibliograph-worker package-worker-deb WORKER_PKG)"
WEB_DEB="$(select_deb bibliograph-web package-web-deb WEB_PKG)"
SEARCH_DEB="$(select_deb bibliograph-search package-search-deb SEARCH_PKG)"

HV_NAME="$(basename "$HV_DEB")"
WORKER_NAME="$(basename "$WORKER_DEB")"
WEB_NAME="$(basename "$WEB_DEB")"
SEARCH_NAME="$(basename "$SEARCH_DEB")"

for name in "$HV_NAME" "$WORKER_NAME" "$WEB_NAME" "$SEARCH_NAME"; do
  case "$name" in
    *[!A-Za-z0-9._+-]*) die "package filename '$name' cannot be passed through ssh safely" ;;
  esac
done

[ "$(dpkg-deb -f "$HV_DEB" Package)" = "bibliograph-happyview" ] \
  || die "$HV_DEB is not bibliograph-happyview"
[ "$(dpkg-deb -f "$WORKER_DEB" Package)" = "bibliograph-worker" ] \
  || die "$WORKER_DEB is not bibliograph-worker"
[ "$(dpkg-deb -f "$WEB_DEB" Package)" = "bibliograph-web" ] \
  || die "$WEB_DEB is not bibliograph-web"
[ "$(dpkg-deb -f "$SEARCH_DEB" Package)" = "bibliograph-search" ] \
  || die "$SEARCH_DEB is not bibliograph-search"

HV_VERSION="$(dpkg-deb -f "$HV_DEB" Version)"
WORKER_VERSION="$(dpkg-deb -f "$WORKER_DEB" Version)"
WEB_VERSION="$(dpkg-deb -f "$WEB_DEB" Version)"
HV_ARCH="$(dpkg-deb -f "$HV_DEB" Architecture)"
WORKER_ARCH="$(dpkg-deb -f "$WORKER_DEB" Architecture)"
WEB_ARCH="$(dpkg-deb -f "$WEB_DEB" Architecture)"
SEARCH_ARCH="$(dpkg-deb -f "$SEARCH_DEB" Architecture)"
SEARCH_VERSION="$(dpkg-deb -f "$SEARCH_DEB" Version)"

HV_SHA="$(sha256sum "$HV_DEB" | cut -d' ' -f1)"
WORKER_SHA="$(sha256sum "$WORKER_DEB" | cut -d' ' -f1)"
WEB_SHA="$(sha256sum "$WEB_DEB" | cut -d' ' -f1)"
SEARCH_SHA="$(sha256sum "$SEARCH_DEB" | cut -d' ' -f1)"

if [ "$DRY_RUN" = 1 ]; then
  print_plan
  echo
  echo "Dry run: no ssh, no upload, no install."
  exit 0
fi

for tool in ssh scp; do
  command -v "$tool" >/dev/null || die "$tool is required locally"
done

# ----------------------------------------------------------------- preflight ---

say "Preflight: ssh, sudo, architecture and runtime on $HOST"
PREFLIGHT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'sudo -n bash -s' 2>&1 <<'PRE'
set -eu
cd /
printf 'ARCH=%s\n' "$(dpkg --print-architecture)"
if command -v node >/dev/null 2>&1; then
  printf 'NODE=%s\n' "$(node --version 2>/dev/null || echo unknown)"
else
  printf 'NODE=none\n'
fi
if [ -d /run/systemd/system ]; then printf 'SYSTEMD=yes\n'; else printf 'SYSTEMD=no\n'; fi
command -v apt-get >/dev/null 2>&1 && printf 'APT=yes\n' || printf 'APT=no\n'
command -v curl >/dev/null 2>&1 && printf 'CURL=yes\n' || printf 'CURL=no\n'
command -v nginx >/dev/null 2>&1 && printf 'NGINX=yes\n' || printf 'NGINX=no\n'
command -v psql >/dev/null 2>&1 && printf 'PSQL=yes\n' || printf 'PSQL=no\n'
if legacy_status="$(dpkg-query -W -f='${Status}' bibliograph 2>/dev/null)"; then
  printf 'LEGACY_PKG_STATUS=%s\n' "$legacy_status"
else
  printf 'LEGACY_PKG_STATUS=absent\n'
fi
printf 'LEGACY_PKG_VERSION=%s\n' "$(dpkg-query -W -f='${Version}' bibliograph 2>/dev/null || echo none)"
printf 'LEGACY_SERVICE=%s\n' "$(systemctl is-active bibliograph.service 2>/dev/null || true)"
printf 'LEGACY_WORKER_SERVICE=%s\n' "$(systemctl is-active bibliograph-worker.service 2>/dev/null || true)"
if [ -e /etc/nginx/sites-enabled/bibliograph-platform ] \
   || [ -L /etc/nginx/sites-enabled/bibliograph-platform ]; then
  printf 'LEGACY_SITE_ENABLED=yes\n'
else
  printf 'LEGACY_SITE_ENABLED=no\n'
fi
if [ -e /etc/nginx/sites-available/bibliograph-platform ] \
   || [ -L /etc/nginx/sites-available/bibliograph-platform ]; then
  printf 'LEGACY_SITE_AVAILABLE=yes\n'
else
  printf 'LEGACY_SITE_AVAILABLE=no\n'
fi
env_value() { # file key
  local file="$1" key="$2"
  local value=""
  [ -r "$file" ] || return 0
  value="$(sed -n "s/^${key}=//p" "$file" | tail -1)"
  case "$value" in
    \"*\"|\\'*\\') value="${value#?}"; value="${value%?}" ;;
  esac
  printf '%s' "$value"
}
if [ -r /etc/bibliograph/worker.env ]; then
  printf 'WORKER_ENV=present\n'
  worker_url="$(env_value /etc/bibliograph/worker.env DATABASE_URL)"
  case "$worker_url" in
    *[[:space:]]*) printf 'WORKER_DB_URL=invalid\n' ;;
    postgres://?*|postgresql://?*) printf 'WORKER_DB_URL=valid\n' ;;
    '') printf 'WORKER_DB_URL=empty\n' ;;
    *) printf 'WORKER_DB_URL=invalid\n' ;;
  esac
  atp_did="$(env_value /etc/bibliograph/worker.env ATP_SERVICE_DID)"
  pds_url="$(env_value /etc/bibliograph/worker.env PDS_URL)"
  pds_account="$(env_value /etc/bibliograph/worker.env PDS_ACCOUNT_DID)"
  pds_cred="$(env_value /etc/bibliograph/worker.env PDS_ACCOUNT_PASSWORD)"
  [ -n "$pds_cred" ] || pds_cred="$(env_value /etc/bibliograph/worker.env PDS_ACCESS_TOKEN)"
  if [ -n "$atp_did" ] && [ -n "$pds_url" ] && [ -n "$pds_account" ] && [ -n "$pds_cred" ]; then
    printf 'WORKER_PUBLISHER=configured\n'
  elif [ -n "$pds_url$pds_account$pds_cred$atp_did" ]; then
    printf 'WORKER_PUBLISHER=partial\n'
  else
    printf 'WORKER_PUBLISHER=none\n'
  fi
else
  printf 'WORKER_ENV=missing\nWORKER_DB_URL=empty\nWORKER_PUBLISHER=none\n'
fi
if [ -r /etc/bibliograph/web.env ]; then
  printf 'WEB_ENV=present\n'
  web_hv="$(env_value /etc/bibliograph/web.env HAPPYVIEW_URL)"
  case "$web_hv" in
    *[[:space:]]*) printf 'WEB_HAPPYVIEW_URL=invalid\n' ;;
    http://?*|https://?*) printf 'WEB_HAPPYVIEW_URL=valid\n' ;;
    '') printf 'WEB_HAPPYVIEW_URL=empty\n' ;;
    *) printf 'WEB_HAPPYVIEW_URL=invalid\n' ;;
  esac
  web_port="$(env_value /etc/bibliograph/web.env PORT)"
  case "$web_port" in
    '') printf 'WEB_PORT=default\n' ;;
    *[!0-9]*) printf 'WEB_PORT=invalid\n' ;;
    *)
      if [ "$web_port" -ge 1 ] 2>/dev/null && [ "$web_port" -le 65535 ] 2>/dev/null; then
        printf 'WEB_PORT=ok\n'
      else
        printf 'WEB_PORT=invalid\n'
      fi
      ;;
  esac
  web_db="$(env_value /etc/bibliograph/web.env DATABASE_URL)"
  [ -n "$web_db" ] && printf 'WEB_DATABASE_URL=set\n' || printf 'WEB_DATABASE_URL=empty\n'
  web_pds="$(env_value /etc/bibliograph/web.env PDS_URL)"
  [ -n "$web_pds" ] && printf 'WEB_PDS_URL=set\n' || printf 'WEB_PDS_URL=empty\n'
else
  printf 'WEB_ENV=missing\nWEB_HAPPYVIEW_URL=empty\nWEB_PORT=default\n'
  printf 'WEB_DATABASE_URL=empty\nWEB_PDS_URL=empty\n'
fi
if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then printf 'NGINX_TEST=ok\n'; else printf 'NGINX_TEST=failed\n'; fi
else
  printf 'NGINX_TEST=absent\n'
fi
cert_path=""
if [ -f /etc/nginx/sites-available/bibliograph-web ]; then
  cert_path="$(awk '/^[[:space:]]*ssl_certificate[[:space:]]/ {print $2; exit}' \
    /etc/nginx/sites-available/bibliograph-web 2>/dev/null || true)"
  cert_path="${cert_path%;}"
fi
[ -n "$cert_path" ] || cert_path=/etc/letsencrypt/live/biblio.livtet.olamaelcu.net/fullchain.pem
if [ -f "$cert_path" ]; then printf 'CERT=ok\n'; else printf 'CERT=missing\n'; fi
printf 'CERT_PATH=%s\n' "$cert_path"
awk '/^MemAvailable:/ {print "MEM_AVAILABLE_KB="$2}' /proc/meminfo || true
df -Pk / 2>/dev/null | awk 'NR==2 {print "DISK_AVAILABLE_KB="$4}' || true
PRE
)" || {
  printf '%s\n' "$PREFLIGHT" >&2
  die "cannot reach $HOST with passwordless sudo (try: ssh -o BatchMode=yes $HOST 'sudo -n true')"
}

preflight_value() {
  printf '%s\n' "$PREFLIGHT" | sed -n "s/^$1=//p" | tail -1
}

HOST_ARCH="$(preflight_value ARCH)"
NODE_VERSION="$(preflight_value NODE)"
HAS_SYSTEMD="$(preflight_value SYSTEMD)"
HAS_APT="$(preflight_value APT)"
HAS_CURL="$(preflight_value CURL)"
HAS_NGINX="$(preflight_value NGINX)"
HAS_PSQL="$(preflight_value PSQL)"
LEGACY_PKG_STATUS="$(preflight_value LEGACY_PKG_STATUS)"
LEGACY_PKG_VERSION="$(preflight_value LEGACY_PKG_VERSION)"
LEGACY_SERVICE="$(preflight_value LEGACY_SERVICE)"
LEGACY_WORKER_SERVICE="$(preflight_value LEGACY_WORKER_SERVICE)"
LEGACY_SITE_ENABLED="$(preflight_value LEGACY_SITE_ENABLED)"
LEGACY_SITE_AVAILABLE="$(preflight_value LEGACY_SITE_AVAILABLE)"
WORKER_ENV="$(preflight_value WORKER_ENV)"
WORKER_DB_URL="$(preflight_value WORKER_DB_URL)"
WORKER_PUBLISHER="$(preflight_value WORKER_PUBLISHER)"
WEB_ENV="$(preflight_value WEB_ENV)"
WEB_HAPPYVIEW_URL="$(preflight_value WEB_HAPPYVIEW_URL)"
WEB_PORT="$(preflight_value WEB_PORT)"
WEB_DATABASE_URL="$(preflight_value WEB_DATABASE_URL)"
WEB_PDS_URL="$(preflight_value WEB_PDS_URL)"
NGINX_TEST="$(preflight_value NGINX_TEST)"
CERT="$(preflight_value CERT)"
CERT_PATH="$(preflight_value CERT_PATH)"
MEM_KB="$(preflight_value MEM_AVAILABLE_KB)"
DISK_KB="$(preflight_value DISK_AVAILABLE_KB)"

[ -n "$HOST_ARCH" ] || die "preflight did not report the host architecture"
[ "$HAS_SYSTEMD" = yes ] || die "$HOST does not run systemd; the packages' units cannot start"
[ "$HAS_APT" = yes ] || die "$HOST has no apt-get; these are Debian packages"
[ "$HAS_CURL" = yes ] || die "curl is required on $HOST for post-install verification"
[ "$NODE_VERSION" != none ] || die "no nodejs on $HOST; install NodeSource node_22.x (worker Depends: nodejs >= 22)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "unexpected node version '$NODE_VERSION' on $HOST" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "node $NODE_VERSION on $HOST; bibliograph-worker needs >= 22"

for arch in "$HV_ARCH" "$WORKER_ARCH" "$WEB_ARCH"; do
  [ "$arch" = all ] || [ "$arch" = "$HOST_ARCH" ] \
    || die "architecture mismatch: package is $arch, host is $HOST_ARCH"
done

LEGACY_PRESENT=0
case "$LEGACY_PKG_STATUS" in
  ''|absent|*not-installed*) : ;;
  *) LEGACY_PRESENT=1 ;;
esac
if [ "$LEGACY_SERVICE" = active ]; then
  LEGACY_PRESENT=1
fi
if [ "$LEGACY_SITE_ENABLED" = yes ]; then
  LEGACY_PRESENT=1
fi

if [ "$LEGACY_PRESENT" = 1 ]; then
  say "Legacy combined package/site detected on $HOST"
  note "package:  ${LEGACY_PKG_STATUS:-absent} (version ${LEGACY_PKG_VERSION:-none})"
  note "units:    bibliograph.service ${LEGACY_SERVICE:-unknown}, bibliograph-worker.service ${LEGACY_WORKER_SERVICE:-unknown}"
  note "nginx:    sites-enabled/bibliograph-platform ${LEGACY_SITE_ENABLED:-no}, sites-available ${LEGACY_SITE_AVAILABLE:-no}"
  if [ "$REPLACE_LEGACY" = 0 ]; then
    die "the retired combined package/site is still present on $HOST, so the split web package would refuse to enable its vhost and the old app would keep serving. Nothing was uploaded or changed.
  Re-run with --replace-legacy to stop/purge it and cut over, or remove it manually first:
    sudo apt-get purge bibliograph
    sudo rm -f /etc/nginx/sites-enabled/bibliograph-platform
    sudo nginx -t && sudo systemctl reload nginx
  Purging removes the old package's conffile edits; PostgreSQL data is not touched."
  fi
  note "--replace-legacy: after happyview and the DB gate, stop/purge the old package before installing the worker (both ship bibliograph-worker.service)"
else
  say "No retired combined package or legacy nginx site on $HOST"
  if [ "$REPLACE_LEGACY" = 1 ]; then
    note "--replace-legacy given but nothing legacy was found; purge steps are no-ops (the new-vhost/HTTPS checks still apply)"
  fi
fi

# A cutover removes the old site, so everything the new stack needs must exist
# before anything is uploaded or changed. These files are pre-staged conffiles;
# dpkg preserves them with --force-confold when the packages install later.
if [ "$REPLACE_LEGACY" = 1 ]; then
  missing_env=0
  [ "$WORKER_ENV" = present ] || missing_env=1
  [ "$WEB_ENV" = present ] || missing_env=1
  if [ "$missing_env" = 1 ]; then
    printf 'ERROR: the legacy cutover needs the new package conffiles staged on %s before anything is uploaded.\n' "$HOST" >&2
    printf '       Removing the old site without them would leave nothing to serve.\n' >&2
    [ "$WORKER_ENV" = present ] || stage_env_hint "$WORKER_NAME" worker.env >&2
    [ "$WEB_ENV" = present ] || stage_env_hint "$WEB_NAME" web.env >&2
    cat >&2 <<'ENVHELP'
  Then set:
    worker.env: DATABASE_URL=postgres://user:pass@host:5432/database
    web.env:    HAPPYVIEW_URL=http://127.0.0.1:3000 and PORT=5176 (or the vhost port)
  and re-run 'mise run deploy -- --replace-legacy'. Nothing was uploaded or changed.
ENVHELP
    exit 1
  fi
  case "$WORKER_DB_URL" in
    valid) ;;
    empty|invalid)
      die "/etc/bibliograph/worker.env has a${WORKER_DB_URL:+n} $WORKER_DB_URL DATABASE_URL. Set a non-empty postgres:// or postgresql:// URL there before the cutover; a missing value would take the old site down with nothing to replace it. The host was not changed."
      ;;
    *) die "could not read DATABASE_URL from /etc/bibliograph/worker.env; the host was not changed" ;;
  esac
  case "$WEB_HAPPYVIEW_URL" in
    valid) ;;
    empty|invalid)
      die "/etc/bibliograph/web.env has ${WEB_HAPPYVIEW_URL:-no} HAPPYVIEW_URL. Set HAPPYVIEW_URL=http://127.0.0.1:3000 (or the real upstream) before the cutover; the host was not changed."
      ;;
    *) die "could not read HAPPYVIEW_URL from /etc/bibliograph/web.env; the host was not changed" ;;
  esac
  case "$WEB_PORT" in
    ok|default) ;;
    *) die "/etc/bibliograph/web.env has an invalid PORT; set PORT=5176 (or the port the packaged nginx vhost proxies to) and re-run. The host was not changed." ;;
  esac
  case "$NGINX_TEST" in
    ok) ;;
    absent) die "nginx is required for a legacy cutover, but it is not installed on $HOST; install nginx first. The retired package/site was not touched." ;;
    failed) die "nginx -t fails on $HOST before the cutover; fix the existing nginx configuration first. The retired package/site was not touched." ;;
    *) die "could not determine nginx state on $HOST; the host was not changed" ;;
  esac
  if [ "$CERT" != ok ]; then
    cert_name="${CERT_PATH#/etc/letsencrypt/live/}"
    cert_name="${cert_name%%/*}"
    [ -n "$cert_name" ] || cert_name='<server_name>'
    die "the TLS certificate required by the new vhost is missing at ${CERT_PATH:-<unknown path>}. The old site must keep serving until the new one can be enabled, so the cutover is refused. Obtain the certificate first, e.g.:
    ssh $HOST 'sudo certbot certonly --webroot -w /var/lib/certbot -d $cert_name'
  then re-run. The host was not changed."
  fi
  [ "$WORKER_PUBLISHER" = configured ] \
    || note "WARNING: publisher config is ${WORKER_PUBLISHER:-unknown}; pds-publish will be disabled (catalog hydration still runs)"
  [ "$WEB_DATABASE_URL" = set ] \
    || note "WARNING: web.env has no DATABASE_URL; anonymous catalog procedures will answer 503"
  [ "$WEB_PDS_URL" = set ] \
    || note "WARNING: web.env has no PDS_URL; publisher record reads will answer 503"
fi

[ "$HAS_PSQL" = yes ] \
  || note "psql is not installed yet; bibliograph-happyview Depends: postgresql-client, so the database stages re-check after it installs"
[ "$HAS_NGINX" = no ] && note "nginx is not installed; bibliograph-web will only listen on 127.0.0.1"
if [ -n "$MEM_KB" ] && [ "$MEM_KB" -lt 350000 ] 2>/dev/null; then
  note "WARNING: only $((MEM_KB / 1024)) MiB available; postgres + HappyView + 2 node processes may OOM"
fi
if [ -n "$DISK_KB" ] && [ "$DISK_KB" -lt 3000000 ] 2>/dev/null; then
  note "WARNING: low disk on /: $((DISK_KB / 1024)) MiB free"
fi
say "Preflight ok: arch $HOST_ARCH, node $NODE_VERSION, nginx $HAS_NGINX"

# -------------------------------------------------------------------- upload ---

say "Uploading $HV_NAME, $WORKER_NAME, $SEARCH_NAME and $WEB_NAME to $HOST:/tmp/"
scp -q "$HV_DEB" "$WORKER_DEB" "$SEARCH_DEB" "$WEB_DEB" "$HOST:/tmp/"

# ---------------------------------------------- install, bootstrap, verify ---

say "Installing and verifying on $HOST (dependency order)"
REMOTE_ARGS="--"
for arg in "$HV_NAME" "$HV_SHA" "$WORKER_NAME" "$WORKER_SHA" "$WEB_NAME" "$WEB_SHA" \
           "$SKIP_DB" "$SKIP_NGINX" "$REPLACE_LEGACY" "$SKIP_BOOKHIVE" \
           "$SEARCH_NAME" "$SEARCH_SHA"; do
  REMOTE_ARGS="$REMOTE_ARGS '$arg'"
done

remote_script | ssh -o BatchMode=yes "$HOST" "sudo -n bash -s $REMOTE_ARGS"

say "Deployed to $HOST"
cat <<'NEXT'

What the packages cannot do for you:
  * Database, HappyView role and catalog schema are host prerequisites for the
    first run; this script gates on them and prints the exact commands.
    See docs/operations/fresh-database.md and docs/deploy/debian.md.
  * Secrets (conffiles, preserved by --force-confold):
      /etc/bibliograph/happyview.env  DATABASE_URL (role happyview_app),
                                      SESSION_SECRET (>= 64 chars),
                                      TOKEN_ENCRYPTION_KEY
      /etc/bibliograph/worker.env     DATABASE_URL, ATP_SERVICE_DID, PDS_URL,
                                      PDS_ACCOUNT_DID,
                                      PDS_ACCOUNT_PASSWORD or PDS_ACCESS_TOKEN,
                                      provider API keys
      /etc/bibliograph/web.env        DATABASE_URL (SELECT-only catalog role),
                                      PDS_URL, optional ORIGIN
    then: systemctl restart happyview bibliograph-worker bibliograph-web
  * nginx/TLS: the bibliograph-web package's site is installed and enabled by
    its postinst as its packaging dictates; this script only runs nginx -t and
    reloads when nginx is present. Certificates remain the host's job.
  * This is a fresh-start deployment: no data migration, no import, no seed.
    The catalog grows from XRPC traffic. Staging, canary and rollback are out
    of scope (rollback is a pin to an older package version).
NEXT

exit 0
