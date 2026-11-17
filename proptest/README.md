# proptest discovery suite

Property-testing harnesses for this repository, built with
[`proptest-praxis`](../.agents/skills/proptest-praxis/SKILL.md) and bound to
`fast-check` by [`proptest-bibliograph`](../.agents/skills/proptest-bibliograph/SKILL.md).
Discovery branch only: these files are not part of any package's `test` script
and never ship.

Harness written against `main` @ `3fbeae0` (the skill integration commit; no
production file had changed since the targets below were last touched).

## Run

```bash
node --test proptest/*.test.ts            # every target
node --test proptest/record-fields.test.ts
node --test proptest/rate-limit.test.ts
node --test proptest/cached-loader.test.ts
```

`fast-check` is a workspace-root devDependency; `node --test` runs the `.ts`
harnesses through Node 26 type stripping. No database, no network, no
`$env`/SvelteKit imports.

## Targets

| Harness | Production code | Runs |
| --- | --- | --- |
| `record-fields.test.ts` | `packages/worker/lib/record-fields.js` — `clippedText`, `isoCalendarDate`, `canonicalIdentifiers`, `httpUrl` | 10,000 per property |
| `rate-limit.test.ts` | `packages/web/src/lib/server/covers/rate-limit.ts` — `createTokenBucket` | 1,000 event traces, 200 targeted |
| `cached-loader.test.ts` | `packages/web/src/lib/server/cached-loader.ts` — `cachedLoader` | 1,000 command programs (12 commands each) |

The oracles are independent: a leap table instead of `Date`, integer
micro-tokens instead of the production float refill, an explicit
`fresh | stale | loading` reference loader instead of the closure under test.

## Next targets

Not started; each has a pure core worth a harness.

- `packages/worker/lib/publish.js` — outbox claim / lease / attempts
- `packages/worker/lib/resolve-format.js` — `normalizeFormatIsbns`
- `packages/worker/lib/genres.js`
- `packages/worker/lib/isbndb-names.js`
- `packages/web/src/lib/server/xrpc/identifiers.ts` — `parseIdentifierParams`
- `packages/web/src/lib/server/admin/merge.ts`, `edition-merge.ts`
- `packages/web/src/lib/server/catalog/search-hydration.ts`
- `packages/web/src/lib/server/covers/cache.ts` — `coverEtag`, `normalizeIfNoneMatch`
- `packages/worker/lib/cover-cache.js`

Excluded: anything needing Postgres (`catalog/editions.ts`, the `admin/*-db`
tests).

## Observed coverage

- `record-fields`: text pieces include combining marks, the ZWJ family, a
  regional-indicator flag, skin-tone and ZWJ variants, CJK, SOFT HYPHEN, ZWSP,
  ZWJ and ZWNJ, `\r\n`, NBSP and lone surrogates, alone and interleaved, with
  `maxGraphemes` 0–8 and `maxBytes` 0–32 — so the empty clip, the
  grapheme-bound clip, the byte-bound clip and the "first grapheme already too
  long" path all occur. Dates: generated `(year, month, day)` over years 0–9999
  with the century/leap edges pinned, plus near-miss strings (suffixes, `T00:00:00Z`,
  zero-padded and unpadded fields) and arbitrary binary text. Identifiers:
  duplicate keys, blank and whitespace halves, non-object entries, `url`
  present/blank/absent, and deliberately collation-equivalent name pairs.
  URLs: `http`, `https`, `HTTP`, `ftp`, `mailto`, protocol-relative, relative,
  empty host, spaced host, non-ASCII host.
- `rate-limit`: traces of up to 40 events over a 1–4 key pool with
  `capacity` 1–8 and `refillPerSecond` 0.001–5, both with room under `maxKeys`
  (conservation) and over it (eviction). Grants, refusals, refusal-then-wait,
  the "newest key keeps its burst after eviction" path and the idle-refill-at-
  the-cap path all occur.
- `cached-loader`: command programs over read, clock advance, resolve and
  reject, `ttlMs` 0–1000 and both `staleWhileRevalidate` settings. Hits the
  fresh hit, the expired refresh, the shared in-flight load, the SWR burst
  (one refresh behind many callers), failure-then-retry, and `ttlMs: 0`.

## Blind spots

- No database: every `db`-suffixed test target stays out of this suite.
- No `$env`/SvelteKit module: anything importing them needs its pure part
  extracted first, which this campaign does not do.
- Concurrency: Node's single-threaded scheduler is the only interleaving
  explored — `drain()` flushes microtasks between commands, so worker-thread
  races and multi-process rate-limit sharing are unobserved.
- Rate limiter: the model keeps integer micro-tokens, so decisions within 200
  micro-tokens of the one-token boundary are treated as ambiguous rather than
  compared.
- `clippedText` trims the prefix it returns, so a whitespace grapheme at the
  clip boundary is unobservable; the maximality property is stated modulo that
  strip.
- `Intl.Segmenter` and `localeCompare` use the process default locale.
