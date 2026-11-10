#!/usr/bin/env tsx
// Fill `actors`, the reader directory behind
// `net.olamaelcu.livtet.biblio.searchActors`.
//
// Two phases per run:
//
//   1. seed — one `INSERT … SELECT DISTINCT did FROM records`, so every DID the
//      TAP mirror has seen gets a row even before its identity is resolved.
//      A seeded row is stamped at the epoch, which makes it the first thing
//      phase 2 picks up.
//   2. resolve — the stalest `--limit` DIDs are resolved through
//      `app.bsky.actor.getProfiles` (25 actors per call), which answers
//      handle, display name, description and avatar for network accounts. A DID
//      the public AppView does not know falls back to its DID document's
//      `alsoKnownAs` for the handle alone.
//
// `updated_at` is the last attempt, not the last success: a DID that resolves to
// nothing is retried after the refresh window instead of on every tick, and a
// request that failed outright is not stamped at all, so the next tick retries
// it immediately.
//
// Profile records are NOT the source here. The mirror subscribes to
// `net.olamaelcu.livtet.biblio.*` and `buzz.bookhive.book`; Livtet's profile
// lives at `net.olamaelcu.livtet.actor.profile`, which TAP filters out before
// the consumer sees it. That is an ingestion gap, not something this script can
// paper over — see the note in `docs/architecture.md`.
//
// Usage:
//   pnpm backfill:actors                     # seed + resolve the stalest 2000
//   pnpm backfill:actors -- --limit=200
//   pnpm backfill:actors -- did:plc:a did:plc:b   # resolve just these DIDs
//
// Requires DATABASE_URL. BSKY_PUBLIC_APPVIEW overrides the default
// `https://public.api.bsky.app`.

import { asc, lt, sql } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { actors } from '../src/lib/server/db/schema';
import { requestJson } from '../src/lib/server/http/client';
import { actorHandle } from '../src/lib/server/pds/resolve';
import { mapWithConcurrency } from '../src/lib/server/pds/fanout';
import { avatarCidFromUrl } from '../src/lib/server/actor-directory';
import { createLogger } from '../src/lib/server/logger';
import { ProgressBar } from './lib/progress';

const log = createLogger('worker');

const PUBLIC_APPVIEW = process.env.BSKY_PUBLIC_APPVIEW ?? 'https://public.api.bsky.app';
/** `app.bsky.actor.getProfiles` accepts at most 25 actors per call. */
const PROFILE_BATCH_SIZE = 25;
/** DID-document fallbacks are one request each; keep them in a few waves. */
const FALLBACK_CONCURRENCY = 4;
/**
 * A row is stale once it has not been attempted for a week. Newly seeded rows
 * carry the epoch, so they are stale by this predicate on their first run.
 */
const REFRESH_WINDOW = sql`now() - interval '7 days'`;
/** The whole directory is ~1.1k DIDs, i.e. ~45 getProfiles calls. */
const DEFAULT_LIMIT = 2_000;

interface PublicProfile {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
}

interface ResolvedActor {
  did: string;
  handle: string | null;
  displayName: string | null;
  description: string | null;
  avatarCid: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `handle.invalid` is the public AppView's placeholder for an account whose
 * handle no longer verifies. It is not a handle a reader can type, so the
 * directory stores nothing rather than publishing it.
 */
function usableHandle(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'handle.invalid' ? trimmed : null;
}

function parseLimit(argv: string[]): number {
  const inline = argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  const separate = argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : undefined;
  const parsed = Number(inline ?? separate);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LIMIT;
}

/**
 * Every DID the mirror holds, in one statement. `ON CONFLICT DO NOTHING` keeps
 * a rerun free: the table is the directory, not a per-record projection.
 */
async function seedDids(): Promise<number> {
  const result = await db.execute<{ did: string }>(sql`
    insert into actors (did, updated_at)
    select distinct did, to_timestamp(0)
      from records
    on conflict (did) do nothing
    returning did
  `);
  return result.rows.length;
}

async function candidateDids(limit: number): Promise<string[]> {
  const rows = await db
    .select({ did: actors.did })
    .from(actors)
    .where(lt(actors.updatedAt, REFRESH_WINDOW))
    .orderBy(asc(actors.updatedAt), asc(actors.did))
    .limit(limit);
  return rows.map((row) => row.did);
}

async function fetchProfiles(dids: readonly string[]): Promise<Map<string, PublicProfile>> {
  const url = new URL('/xrpc/app.bsky.actor.getProfiles', PUBLIC_APPVIEW);
  for (const did of dids) url.searchParams.append('actors', did);
  const body = await requestJson<{ profiles?: PublicProfile[] }>(url.toString(), {
    // Off the request path, and a 25-actor call is slower than a single read.
    timeoutMs: 15_000,
  });
  const profiles = new Map<string, PublicProfile>();
  for (const profile of body?.profiles ?? []) {
    if (profile.did) profiles.set(profile.did, profile);
  }
  return profiles;
}

function resolvedActor(did: string, profile: PublicProfile): ResolvedActor {
  return {
    did,
    handle: usableHandle(profile.handle),
    displayName: nonEmpty(profile.displayName),
    description: nonEmpty(profile.description),
    avatarCid: avatarCidFromUrl(profile.avatar),
  };
}

/** A full profile is authoritative at read time: nulls clear stale fields. */
async function storeProfiles(rows: readonly ResolvedActor[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(actors)
    .values([...rows])
    .onConflictDoUpdate({
      target: actors.did,
      set: {
        handle: sql`excluded.handle`,
        displayName: sql`excluded.display_name`,
        description: sql`excluded.description`,
        avatarCid: sql`excluded.avatar_cid`,
        updatedAt: sql`now()`,
      },
    });
}

/** The DID-document fallback knows only the handle; keep what was already there. */
async function storeHandles(rows: readonly { did: string; handle: string | null }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(actors)
    .values([...rows])
    .onConflictDoUpdate({
      target: actors.did,
      set: {
        handle: sql`coalesce(excluded.handle, ${actors.handle})`,
        updatedAt: sql`now()`,
      },
    });
}

async function resolveBatch(dids: readonly string[]): Promise<{ unknown: number; failed: boolean }> {
  let profiles: Map<string, PublicProfile>;
  try {
    profiles = await fetchProfiles(dids);
  } catch (err) {
    // Not stamped: the next tick retries the same rows rather than waiting a
    // week for an answer the network never gave.
    log.warn({ err, dids: dids.length }, 'actors: profile batch failed');
    return { unknown: 0, failed: true };
  }

  const found: ResolvedActor[] = [];
  const unresolvedDids: string[] = [];
  for (const did of dids) {
    const profile = profiles.get(did);
    if (profile) {
      found.push(resolvedActor(did, profile));
      continue;
    }
    unresolvedDids.push(did);
  }

  const fallbacks = await mapWithConcurrency(unresolvedDids, FALLBACK_CONCURRENCY, async (did) => ({
    did,
    handle: await actorHandle(did),
  }));

  await storeProfiles(found);
  await storeHandles(fallbacks);
  return { unknown: fallbacks.length, failed: false };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const explicit = argv.filter((arg) => arg.startsWith('did:'));

  const seeded = explicit.length > 0 ? 0 : await seedDids();
  const dids = explicit.length > 0 ? explicit : await candidateDids(parseLimit(argv));
  log.info({ seeded, candidates: dids.length }, 'actors: seeded from records');

  const progress = new ProgressBar('actors', dids.length);
  let unknown = 0;
  let failedBatches = 0;
  for (let i = 0; i < dids.length; i += PROFILE_BATCH_SIZE) {
    const batch = dids.slice(i, i + PROFILE_BATCH_SIZE);
    const result = await resolveBatch(batch);
    unknown += result.unknown;
    if (result.failed) failedBatches += 1;
    progress.advance(batch.length);
  }
  progress.finish();

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      identified: sql<number>`count(${actors.handle})::int`,
    })
    .from(actors);

  log.info(
    {
      seeded,
      attempted: dids.length,
      unresolved: unknown,
      failedBatches,
      total: totals?.total ?? 0,
      identified: totals?.identified ?? 0,
    },
    'actors: backfill complete',
  );
}

main().catch((err) => {
  log.error({ err }, 'actors: backfill failed');
  process.exit(1);
});
