---
name: logs
description: Use when running or writing request-driven tests in bibliograph and needing to inspect what the server actually did between requests or assertions — e.g. debugging an XRPC handler, verifying a child logger's requestId was set, checking whether a log line was emitted, or tracing a request through middleware. Also use when a test fails and you suspect a server-side behavior the client can't see.
---

# Local request logs

`src/logger.ts` writes daily-rotated JSON logs to `./logs/` **only when `LOG_DIR` is set**. Stdout alone is not enough between request operations — you need the file to inspect what happened during a specific request.

## Enable

```bash
LOG_DIR="$(pwd)/logs" pnpm test
# or for a one-off server run:
LOG_DIR="$(pwd)/logs" pnpm run dev
```

Without `LOG_DIR`, the directory stays empty and you only get stdout.

## Path and format

- Files: `./logs/app.YYYY-MM-DD.N.log` (pino-roll daily rotation; `.N` increments when a same-day file already exists)
- JSON lines, one record per line: `{level, time, pid, hostname, msg, ...fields}`

## Inspect between operations

```bash
# Most recent lines, freshest at bottom
tail -f logs/app.*.log

# Lines for one request (the requestId in middleware logs is the join key)
tail -F logs/app.*.log | jq -c "select(.requestId == \"$REQ_ID\")"

# Only errors / warnings
jq -c 'select(.level >= 40)' logs/app.*.log

# Bump verbosity for the next run
LOG_LEVEL=debug LOG_DIR="$(pwd)/logs" pnpm test
```

## Common fields emitted

| field | where | meaning |
|---|---|---|
| `requestId` | `middleware.ts` `requestTracing` | per-request join key (also echoed in `X-Request-Id` response header) |
| `method`, `path`, `status`, `duration` | middleware | one line per completed request |
| `err` | catch blocks | pino's err serializer — includes `message`, `stack`, `cause` chain |
| `jetstream:*` | `src/jetstream/ingest.ts` | connect / cursor / event handling |

## When NOT to use

- Client-side only — there are no server logs to inspect.
- One-shot `assert.equal(...)` pass/fail — stdout from the test runner is enough.
- Production debugging — use `ssh veve@lescayes.ts.olamaelcu.net 'sudo dokku enter bibliograph web -- cat /app/logs/app.*.log'` (see `~/.config/opencode/opencode.json` + memory).