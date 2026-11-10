// Follow edges are `net.olamaelcu.livtet.biblio.follow` records in the
// follower's own repo (`subject` = the followed actor's at-uri, key type `tid`).
// The repo is authoritative. TAP mirrors those records into `records`, and
// `follows` is a derived read index over that mirror: one row per
// (follower, followed) pair.
//
// The index is recomputed from `records` rather than adjusted in place. A repo
// can hold two records for the same subject — the writer reuses an existing
// rkey, but nothing forbids a duplicate — and only the mirror knows whether a
// deleted record left a survivor behind. Recomputing one pair is two indexed
// statements, so the cost stays bounded and a delete racing an upsert cannot
// leave an edge pointing at a record that is gone.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from './db/index';
import { follows, records } from './db/schema';

export const FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow';

export interface FollowEdge {
  followerDid: string;
  followedDid: string;
}

type Db = typeof defaultDb;

/** `subject` names the followed actor as an at-uri; its authority is the DID. */
export function didFromFollowSubject(subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject.startsWith('at://')) return null;
  // `at://<did>/<collection>/<rkey>` — a bare identity is `at://<did>`. Splitting
  // on `/` yields `['at:', '', '<did>', ...]`, so the authority is index 2.
  const did = subject.split('/')[2];
  return did && did.startsWith('did:') ? did : null;
}

/** The edge one follow record represents, or `null` when it names no identity. */
export function followEdgeFromRecord(
  did: string,
  value: Record<string, unknown>,
): FollowEdge | null {
  const followedDid = didFromFollowSubject(value.subject);
  return followedDid ? { followerDid: did, followedDid } : null;
}

/** `createdAt` as the record states it, falling back to when we mirrored it. */
function recordCreatedAt(value: unknown, fallback: Date): Date {
  const raw = (value as { createdAt?: unknown } | null)?.createdAt;
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

/**
 * Rewrite one edge from the mirror. Callers must already have applied their
 * `records` mutation, so the mirror is the post-state: a pair with no record
 * left loses its row, one that still has a record gets it back.
 */
export async function syncFollowEdge(edge: FollowEdge, db: Db = defaultDb): Promise<void> {
  const subject = `at://${edge.followedDid}`;
  const [survivor] = await db
    .select({ value: records.value, createdAt: records.createdAt })
    .from(records)
    .where(
      and(
        eq(records.collection, FOLLOW_COLLECTION),
        eq(records.did, edge.followerDid),
        sql`${records.value} ->> 'subject' = ${subject}`,
      ),
    )
    .limit(1);

  if (survivor) {
    await db
      .insert(follows)
      .values({
        followerDid: edge.followerDid,
        followedDid: edge.followedDid,
        createdAt: recordCreatedAt(survivor.value, survivor.createdAt),
      })
      .onConflictDoNothing();
    return;
  }

  await db
    .delete(follows)
    .where(
      and(
        eq(follows.followerDid, edge.followerDid),
        eq(follows.followedDid, edge.followedDid),
      ),
    );
}

/** `syncFollowEdge` over a batch, skipping pairs that name no identity. */
export async function syncFollowEdges(edges: readonly FollowEdge[], db: Db = defaultDb): Promise<void> {
  for (const edge of edges) await syncFollowEdge(edge, db);
}

/**
 * The edges named by records that are about to be deleted. Read *before* the
 * mirror row goes away: the subject is written down nowhere else, and a delete
 * event carries only the uri.
 */
export async function followEdgesForRecordUris(
  uris: readonly string[],
  db: Db = defaultDb,
): Promise<FollowEdge[]> {
  if (uris.length === 0) return [];
  const rows = await db
    .select({ did: records.did, value: records.value })
    .from(records)
    .where(and(eq(records.collection, FOLLOW_COLLECTION), inArray(records.uri, [...uris])));
  const edges: FollowEdge[] = [];
  for (const row of rows) {
    const edge = followEdgeFromRecord(row.did, row.value as Record<string, unknown>);
    if (edge) edges.push(edge);
  }
  return edges;
}
