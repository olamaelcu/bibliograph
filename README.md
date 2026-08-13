# Bibliograph

A collection of tools in one:

- An [ATProto AppView][1] that provides a means of finding information about books, reviews folks have made in the Atmosphere
- An [ATProto feed generator][2] that aggregates user behavior for the purpose of discovery

## Setup

```bash
pnpm install
pnpm run dev:server   # HTTP server on http://localhost:3000
pnpm run dev          # Vite dev server with Hono as middleware

# Or use `mise`
mise dev
```

Check it's alive: `curl http://localhost:3000/health`.

## Environment

| Variable   | Default               | Description                         |
| ---------- | --------------------- | ----------------------------------- |
| `PORT`     | `3000`                | HTTP server port                    |
| `NODE_ENV` | _(unset)_             | `production` enables pino JSON logs |
| `DB_PATH`  | `data/bibliograph.db` | SQLite database path                |

## Scripts

- `pnpm run dev` / `dev:server` — development
- `pnpm run check` — typecheck
- `pnpm run test` — vitest
- `pnpm run build` — compile server to `dist/`
- `pnpm run start` — production server
- `pnpm run release` — Dokku release task
- `pnpm run db:generate` — generate Drizzle migrations

## Deployment

Dokku via `git push dokku main`; `app.json` healthcheck targets `/health`.

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://atproto.com/guides/feeds
