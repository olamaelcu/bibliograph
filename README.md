# Bibliograph

Clean-slate skeleton: a minimal Hono server backed by SQLite (via Drizzle ORM + better-sqlite3). No schema, no endpoints beyond `/health` — the base for rebuilding the ATProto book AppView.

## Setup

```bash
pnpm install
pnpm run dev:server   # HTTP server on http://localhost:3000
pnpm run dev          # Vite dev server with Hono as middleware
```

Check it's alive: `curl http://localhost:3000/health`.

## Environment

| Variable   | Default                | Description                          |
|------------|------------------------|--------------------------------------|
| `PORT`     | `3000`                 | HTTP server port                     |
| `NODE_ENV` | *(unset)*              | `production` enables pino JSON logs  |
| `DB_PATH`  | `data/bibliograph.db`  | SQLite database path                 |

## Scripts

- `pnpm run dev` / `dev:server` — development
- `pnpm run check` — typecheck
- `pnpm run test` — vitest
- `pnpm run build` — compile server to `dist/`
- `pnpm run start` — production server
- `pnpm run release` — Dokku release task (placeholder for future migrations)
- `pnpm run db:generate` — generate Drizzle migrations (empty journal ready)

## Deployment

Dokku via `git push dokku main`; `app.json` healthcheck targets `/health`.
