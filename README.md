# Bibliograph

A collection of tools in one:

- An [ATProto AppView][1] that provides a means of finding information about
  books, reviews folks have made in the Atmosphere
- An [ATProto feed generator][2] that aggregates user behavior for the purpose
  of discovery
- A thin [ATProto PDS][3] whose records are about the books and authors it knows about.

## Setup

```bash
pnpm install
pnpm run dev   # Vite dev server with Hono as middleware on http://localhost:5176

# Or use `mise`
mise dev
```

Check it's alive: `curl http://localhost:5176/health`.

The web UI is served from Eta templates on disk (`src/pages/templates/`):
`/` lists the service overview with counts, `/queries` documents every XRPC
query, and `/procedures` every procedure. Pages are server-side rendered with
[Web Awesome](https://webawesome.com) components and hydrated on the client.

For lexicon schema serving and DNS TXT record setup, see [docs/lexicon-resolution.md](docs/lexicon-resolution.md).

## Environment

| Variable     | Default                                                          | Description                       |
| ------------ | ---------------------------------------------------------------- | --------------------------------- |
| `PORT`       | `3000`                                                           | HTTP server port                  |
| `NODE_ENV`   | _(unset)_                                                        | `production` enables pino JSON logs |
| `DATABASE_URL` | `postgres://bibliograph:bibliograph@localhost:5432/bibliograph` | PostgreSQL connection string      |

## Scripts

- `pnpm run dev` — development (Vite + Hono dev server)
- `pnpm run check` — typecheck
- `pnpm run test` — vitest
- `pnpm run build` — compile server to `dist/`
- `pnpm run start` — production server (runs migrations on startup)
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — apply pending Drizzle migrations
- `pnpm run gb:evict` — prune expired `gb_cache` entries (scheduled hourly)
- `pnpm run lex:gen` / `lex:check` — regenerate / validate lexicon codegen

## Migrations

```bash
pnpm run db:migrate    # apply pending migrations from drizzle/
```

New schema versions are generated with `pnpm run db:generate`. The web
process (`pnpm start`) applies pending migrations itself on startup, so
`db:migrate` is only needed for local development.

## Deployment

Dokku via `git push dokku main`; `app.json` healthcheck targets `/health`.

Provision PostgreSQL and link it to the app:

```bash
dokku postgres:create bibliograph-db
dokku postgres:link bibliograph-db bibliograph
```

Dokku's Postgres plugin auto-injects `DATABASE_URL`. For a single-process
deployment, set `dokku config:set bibliograph PG_MAX_POOL=1`.

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://atproto.com/guides/feeds
[3]: https://atproto.com/specs/repository