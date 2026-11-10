#!/usr/bin/env tsx
//
// Fill `follows` from Constellation.
//
// `follows` is normally materialized from the TAP mirror (`records`), which only
// covers repos our TAP instance has registered. Constellation indexes the whole
// network, so it can name followers whose repo we never subscribed to — the one
// gap the mirror cannot close. It answers the follower direction only: a
// backlink is a link *to* a target, so `subject = at://<did>` yields the DIDs
// that follow `<did>`, never the ones `<did>` follows.
//
//   pnpm backfill:follows                       # every DID with a web session
//   pnpm backfill:follows -- did:plc:a did:plc:b
//   pnpm backfill:follows -- --limit=200        # cap the session-derived set
//
// Safe to re-run: every insert is ON CONFLICT DO NOTHING, and Constellation's
// cursors are opaque, so a rerun re-reads a page rather than corrupting one.
//
// Requires DATABASE_URL. CONSTELLATION_URL overrides the public instance.
//


import { desc, gt, sql } from 'drizzle-orm';
import { db } from '../src/lib/server/db/index';
import { follows, webSessions } from '../src/lib/server/db/schema';
import { getBacklinks, type SocialSource } from '../src/lib/server/constellation/client';
import { createLogger } from '../src/lib/server/logger';


const log = createLogger('worker');

const SOURCE: SocialSource = 'net.olamaelcu.livtet.biblio.follow:subject';
const PAGE_LIMIT = 100;
/** A pathological account must not pin the scan: 50 pages is 5000 followers. */
const MAX_PAGES = 50;

/**
 * Every DID that follows `did`, per Constellation.
 *
 * An unreadable index and an account with no followers both come back as an
 * empty page — `getBacklinks` logs the transport failure and answers with
 * nothing either way — so this deliberately returns a list, not a nullable one,
 * and the caller never reports "unreadable" it cannot actually distinguish.
 */
async function followerDidsOf(did: string): Promise<string[]> {
  const subject = `at://${did}`;
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await getBacklinks({
      subject,
      source: SOURCE,
      limit: PAGE_LIMIT,
      cursor,
    });
    for (const record of result.records) seen.add(record.did);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return [...seen];
}

/** How many target DIDs one run scans. The hourly unit relies on this bound. */
const DEFAULT_TARGET_LIMIT = 500;

function targetLimit(): number {
  // Both `--limit=500` and `--limit 500` are accepted: the packaged units spell
  // it the way the other backfill scripts do (`--limit 1000`), and a human
  // typing it by hand usually writes the `=`.  
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  const separate = args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined;
  const parsed = Number(inline ?? separate);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TARGET_LIMIT;
}

async function targetDids(): Promise<string[]> {
  const explicit = process.argv.slice(2).filter((arg) => arg.startsWith('did:'));
  if (explicit.length > 0) return explicit;

  // Live sessions are who this instance serves, most recently active first, so
  // a run that hits its limit refreshes the people actually here. Expired rows
  // are churn rather than users: scanning them would grow the hourly cost with
  // no follower to gain. `group by` collapses a DID's several sessions.
  const rows = await db
    .select({ did: webSessions.did })
    .from(webSessions)
    .where(gt(webSessions.expiresAt, new Date()))
    .groupBy(webSessions.did)
    .orderBy(desc(sql`max(${webSessions.expiresAt})`))
    .limit(targetLimit());
  return rows.map((row) => row.did);
}

async function main(): Promise<void> {
  const dids = await targetDids();
  if (dids.length === 0) {
    log.info('no target DIDs (no web sessions and none passed on the command line)');
    return;
  }
  log.info({ dids: dids.length }, 'backfilling follows from constellation');

  let inserted = 0;
  let empty = 0;
  for (const did of dids) {
    const followers = await followerDidsOf(did);
    if (followers.length === 0) empty += 1;
    for (const follower of followers) {
      // Constellation answers with did/collection/rkey only — no record body and
      // no `createdAt` — so `created_at` defaults to when we learned the edge,
      // which is the best information this source has.
      // `returning` is the cheap way to count only real inserts: a conflict
      // yields no row, so a rerun logs zero.
      const rows = await db
        .insert(follows)
        .values({ followerDid: follower, followedDid: did })
        .onConflictDoNothing()
        .returning({ followerDid: follows.followerDid });
      inserted += rows.length;
    }
    log.info({ did, followers: followers.length }, 'constellation scan ok');
  }

  const totals = await db.select({ count: sql<number>`count(*)::int` }).from(follows);
  log.info({ inserted, empty, total: totals[0]?.count ?? 0 }, 'backfill complete');
}

main().catch((err) => {
  log.error({ err }, 'backfill failed');
  process.exit(1);
});
