# Contributing to Bibliograph

## Getting started

```bash
git clone <repo-url>
cd bibliograph
npm install
npm run dev
```

The server starts on `http://localhost:3000`. Changes to `src/` are watched and hot-reloaded via `tsx watch`.

## Project conventions

- **Language**: TypeScript with ESM (`"type": "module"`)
- **Formatting**: 2-space indentation, single quotes, trailing commas
- **Patterns**: Prefer arrow functions, `async/await` over raw promises, explicit types over inference for public APIs
- **Database**: Drizzle ORM definitions live in `src/db/schema.ts`. Raw SQL migrations go in `src/db/init.ts`. Don't write ad-hoc queries in handlers — push them through the query builder.

## Before submitting

```bash
npm run build        # tsc --noEmit must pass
npm run dev          # server must start without errors
```

## Lexicon changes

Lexicon JSON schemas live under `lexicons/community/lexicon/book/`. If you add or change a lexicon, also update:

1. `src/types.ts` — mirror the new or changed fields as TypeScript interfaces
2. `src/db/schema.ts` — if a new record type needs indexing
3. `src/db/init.ts` — raw CREATE TABLE must match the Drizzle schema
4. `src/indexer.ts` — add a case for the new collection

## Commit style

```
type(scope): summary

Body with details if needed.
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`. Scopes: `app`, `db`, `api`, `indexer`, `providers`, `lexicons`, `auth`.
