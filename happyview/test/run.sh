#!/usr/bin/env sh
# Syntax-check every Lua module and endpoint, then run the harness. Uses the
# locally installed lua5.1/luac5.1; no install step.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

for file in "$root"/happyview/lib/*.lua \
            "$root"/happyview/scripts/xrpc/query/*.lua \
            "$root"/happyview/scripts/xrpc/procedure/*.lua; do
  luac5.1 -p "$file"
done

exec lua5.1 "$root/happyview/test/harness.lua" "$root"
