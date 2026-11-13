#!/bin/sh
# Re-index the local PDS into HappyView on a cadence.
#
# Jetstream is deliberately closed in this stack (`JETSTREAM_URL=ws://127.0.0.1:1`),
# so a record written straight to the PDS is invisible to the index until a
# backfill walks the repo. The platform reads a reader's shelves from that
# index, which is why a status written by another client does not appear until
# this runs.
#
# Each pass lists the PDS's repos and starts a backfill for every repo whose
# head moved since the last pass. A repo is backfilled once on first sight, so
# records written before this container started are picked up too.
#
# Environment:
#   HAPPYVIEW_URL            admin base (default http://happyview:3000)
#   HAPPYVIEW_ADMIN_KEY      `hv_…` key with backfill:create
#   PDS_URL                  relay to walk (default http://pds:3000)
#   BACKFILL_INTERVAL_SECONDS cadence (default 15)
#   STATE_DIR                where the last-seen heads live (default /state)

set -eu

: "${HAPPYVIEW_URL:=http://happyview:3000}"
: "${PDS_URL:=http://pds:3000}"
: "${BACKFILL_INTERVAL_SECONDS:=15}"
: "${STATE_DIR:=/state}"
: "${HAPPYVIEW_ADMIN_KEY:?HAPPYVIEW_ADMIN_KEY must be set}"

mkdir -p "$STATE_DIR"

# One job per repo: HappyView filters the walk to the collections it has
# lexicons for, and a job covers exactly one DID.
backfill() {
	curl -fsS --max-time 90 -X POST "$HAPPYVIEW_URL/admin/backfill" \
		-H "Authorization: Bearer $HAPPYVIEW_ADMIN_KEY" \
		-H "content-type: application/json" \
		-d "{\"did\":\"$1\"}" >/dev/null
}

while :; do
	if ! repos=$(curl -fsS --max-time 10 "$PDS_URL/xrpc/com.atproto.sync.listRepos?limit=200"); then
		echo "listRepos failed; retrying in ${BACKFILL_INTERVAL_SECONDS}s" >&2
		sleep "$BACKFILL_INTERVAL_SECONDS"
		continue
	fi

	# `listRepos` answers `{"repos":[{"did":…,"head":…,"rev":…},…]}`; splitting on
	# `}` turns it into one object per line, which is all the parsing this needs.
	printf '%s' "$repos" | tr '}' '\n' | while IFS= read -r entry; do
		did=$(printf '%s' "$entry" | grep -o '"did":"[^"]*"' | cut -d'"' -f4 || true)
		head=$(printf '%s' "$entry" | grep -o '"head":"[^"]*"' | cut -d'"' -f4 || true)
		[ -n "$did" ] && [ -n "$head" ] || continue

		stamp="$STATE_DIR/$(printf '%s' "$did" | tr ':/' '__').head"
		if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$head" ]; then
			continue
		fi

		if backfill "$did"; then
			printf '%s' "$head" >"$stamp"
			echo "backfilled $did at $head"
		else
			echo "backfill failed for $did" >&2
		fi
	done

	sleep "$BACKFILL_INTERVAL_SECONDS"
done
