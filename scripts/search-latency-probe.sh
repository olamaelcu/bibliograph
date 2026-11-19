#!/usr/bin/env bash
# Percentile latency probe for catalog search, engine and edge.
#
# Run it on the catalog host, at the same load conditions as the recording you
# compare against (the PSI/load line is printed first for exactly that reason).
# Single samples are misleading: this makes SAMPLES requests per shape, drops
# the status from the timing, and reports p50/p95 in milliseconds.
#
#   ./search-latency-probe.sh                      # engine + edge, 20 samples
#   SAMPLES=40 ENGINE_URL=http://127.0.0.1:3103/search ./search-latency-probe.sh
#
# Exit status is 1 when any shape answered a non-200, so a broken engine is not
# reported as a latency number.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:3103/search}"
XRPC_URL="${XRPC_URL:-http://127.0.0.1:5176/xrpc/community.lexicon.media.book.searchEditions}"
SAMPLES="${SAMPLES:-20}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'pressure: %s\n' "$(head -1 /proc/pressure/io 2>/dev/null || echo 'n/a')"
printf 'load: %s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
printf 'healthz: %s\n' "$(curl -s -m 5 "${ENGINE_URL%/search}/healthz" || true)"
printf 'samples: %s\n\n' "$SAMPLES"

# $1 label, $2 url, $3 body
probe() {
  local label="$1" url="$2" body="$3" i code time
  local times="$tmp/$label.times" bad=0
  : > "$times"
  for ((i = 1; i <= SAMPLES; i++)); do
    read -r code time < <(
      curl -s -o /dev/null -m 20 -w '%{http_code} %{time_total}\n' \
        -X POST -H 'content-type: application/json' -d "$body" "$url"
    )
    [ "$code" = 200 ] || bad=$((bad + 1))
    printf '%s\n' "$time" >> "$times"
  done
  sort -n -o "$times" "$times"
  local p50 p95
  p50="$(awk -v p=0.50 '{a[NR]=$1} END{if(NR==0){print "nan"; exit} i=int(p*NR); if(i<1)i=1; if(i>NR)i=NR; printf "%.1f", a[i]*1000}' "$times")"
  p95="$(awk -v p=0.95 '{a[NR]=$1} END{if(NR==0){print "nan"; exit} i=int(p*NR); if(i<1)i=1; if(i>NR)i=NR; printf "%.1f", a[i]*1000}' "$times")"
  printf '%-26s p50=%8s ms  p95=%8s ms  non200=%s/%s\n' "$label" "$p50" "$p95" "$bad" "$SAMPLES"
  [ "$bad" -eq 0 ]
}

status=0
echo '# engine'
probe 'engine q=dune'            "$ENGINE_URL" '{"q":"dune","limit":25}'            || status=1
probe 'engine title=dune'         "$ENGINE_URL" '{"title":"dune","limit":25}'         || status=1
probe 'engine author=herbert'     "$ENGINE_URL" '{"author":"herbert","limit":25}'     || status=1
probe 'engine offset=5000'        "$ENGINE_URL" '{"q":"the","offset":5000,"limit":25}' || status=1
probe 'engine sort=publishedYear' "$ENGINE_URL" '{"q":"dune","sort":"publishedYear","order":"desc","limit":25}' || status=1

echo
echo '# edge (includes Postgres hydration)'
probe 'xrpc q=dune'            "$XRPC_URL" '{"q":"dune","limit":25}'            || status=1
probe 'xrpc title=dune'        "$XRPC_URL" '{"title":"dune","limit":25}'        || status=1
probe 'xrpc author=herbert'    "$XRPC_URL" '{"author":"herbert","limit":25}'    || status=1

exit "$status"
