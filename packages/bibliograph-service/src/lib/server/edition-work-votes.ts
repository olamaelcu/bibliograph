// Edition→work links are decided by vote, not by a single writer.
//
// Users publish `net.olamaelcu.livtet.biblio.editionWorkLink` records to their
// OWN PDS; Bibliograph ingests them (through TAP) into `edition_work_votes` and
// only rewrites the canonical `editions.work_uri` once a configurable number of
// votes agree. The vote itself lives in the voter's repo, so the tally can be
// audited (and recomputed) from ATProto alone.
//
// `decideConsensus` is pure: it takes a tally and the current link and returns
// the decision. That keeps the interesting rule unit-testable without a
// database, which matters because a wrong rule here silently rewrites the
// catalog.

import { and, asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import { db as defaultDb } from './db/index';
import { editionWorkVotes, editions, works } from './db/schema';
import type { DbExecutor } from './stats';

export const EDITION_WORK_LINK_COLLECTION = 'net.olamaelcu.livtet.biblio.editionWorkLink';
export const EDITION_COLLECTION = 'community.lexicon.book.edition';
export const WORK_COLLECTION = 'community.lexicon.book.work';

/** `editions.work_link_source` value for links decided by vote. */
export const LINK_SOURCE_CONSENSUS = 'consensus';

export const DEFAULT_CONSENSUS_THRESHOLD = 2;

export type VoteAction = 'link' | 'unlink';

export interface EditionWorkVote {
  editionUri: string;
  voterDid: string;
  action: VoteAction;
  workUri?: string;
  workCid?: string;
  recordUri: string;
}

export interface VoteTally {
  /** Link votes per work, most-voted first, ties broken by URI for determinism. */
  links: Array<{ workUri: string; count: number }>;
  unlinkCount: number;
  /** Link votes pointing at a work that is not in the catalog (ignored). */
  ignoredUnknownWork: number;
}

export type ConsensusDecision =
  | { action: 'link'; workUri: string }
  | { action: 'unlink' }
  | { action: 'none'; reason: 'no-votes' | 'below-threshold' | 'already-satisfied' };

export function consensusThreshold(raw: string | undefined = process.env.EDITION_WORK_CONSENSUS_THRESHOLD): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONSENSUS_THRESHOLD;
  return Math.floor(parsed);
}

function isAtUri(value: unknown, collection: string): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('at://')) return false;
  return value.split('/')[3] === collection;
}

/**
 * The rkey is the edition's rkey, so an account holds exactly one vote per
 * edition: changing your mind updates your existing record instead of stacking
 * a second vote.
 */
export function voteRkeyForEdition(editionUri: string): string {
  const tail = editionUri.split('/').pop() ?? '';
  const safe = tail.replace(/[^a-zA-Z0-9._:~-]/g, '-');
  if (safe.length === 0) return 'unknown';
  return safe.slice(0, 512);
}

export function editionUriForRkey(rkey: string, publisherDid: string): string {
  return `at://${publisherDid}/${EDITION_COLLECTION}/${rkey}`;
}

/**
 * Normalize a record from a user's repo into a vote, or return null when it is
 * not a well-formed vote. Malformed records are ignored, never guessed at.
 */
export function parseEditionWorkVote(
  uri: string,
  did: string,
  value: Record<string, unknown>,
): EditionWorkVote | null {
  if (value.$type !== EDITION_WORK_LINK_COLLECTION) return null;

  const edition = value.edition as { uri?: unknown } | undefined;
  if (!edition || !isAtUri(edition.uri, EDITION_COLLECTION)) return null;

  const action = value.action;
  if (action !== 'link' && action !== 'unlink') return null;

  const base: EditionWorkVote = {
    editionUri: edition.uri,
    voterDid: did,
    action,
    recordUri: uri,
  };

  if (action === 'unlink') return base;

  const work = value.work as { uri?: unknown; cid?: unknown } | undefined;
  if (!work || !isAtUri(work.uri, WORK_COLLECTION)) return null;
  return {
    ...base,
    workUri: work.uri,
    workCid: typeof work.cid === 'string' ? work.cid : undefined,
  };
}

/**
 * Pure consensus rule.
 *
 * A work wins the link vote when `bestLinkVotes - unlinkVotes >= threshold`.
 * The edition is unlinked when `unlinkVotes - bestLinkVotes >= threshold`.
 * Anything else leaves the catalog untouched — a lone dissenting vote never
 * overwrites an established link, which is the whole point of voting.
 *
 * When the current work is tied for most votes it stays selected, so the
 * decision does not flap between equally-supported works as votes trickle in.
 */
export function decideConsensus(
  tally: VoteTally,
  currentWorkUri: string | null,
  threshold: number,
): ConsensusDecision {
  const best = tally.links[0];
  const bestCount = best?.count ?? 0;

  let chosen: string | undefined = best?.workUri;
  if (currentWorkUri) {
    const currentTally = tally.links.find((l) => l.workUri === currentWorkUri);
    if (currentTally && currentTally.count === bestCount) chosen = currentWorkUri;
  }

  const linkScore = bestCount - tally.unlinkCount;
  const unlinkScore = tally.unlinkCount - bestCount;

  if (chosen && linkScore >= threshold) {
    if (chosen === currentWorkUri) return { action: 'none', reason: 'already-satisfied' };
    return { action: 'link', workUri: chosen };
  }

  if (unlinkScore >= threshold) {
    if (currentWorkUri === null) return { action: 'none', reason: 'already-satisfied' };
    return { action: 'unlink' };
  }

  if (bestCount === 0 && tally.unlinkCount === 0) return { action: 'none', reason: 'no-votes' };
  return { action: 'none', reason: 'below-threshold' };
}

export async function tallyVotes(editionUri: string, db: DbExecutor = defaultDb): Promise<VoteTally> {
  const linkRows = await db
    .select({ workUri: editionWorkVotes.workUri, c: count() })
    .from(editionWorkVotes)
    .innerJoin(works, eq(works.uri, editionWorkVotes.workUri))
    .where(and(eq(editionWorkVotes.editionUri, editionUri), eq(editionWorkVotes.action, 'link')))
    .groupBy(editionWorkVotes.workUri)
    .orderBy(desc(count()), asc(editionWorkVotes.workUri));

  const [unlinkRow] = await db
    .select({ c: count() })
    .from(editionWorkVotes)
    .where(and(eq(editionWorkVotes.editionUri, editionUri), eq(editionWorkVotes.action, 'unlink')));

  const [totalLinkRow] = await db
    .select({ c: count() })
    .from(editionWorkVotes)
    .where(
      and(
        eq(editionWorkVotes.editionUri, editionUri),
        eq(editionWorkVotes.action, 'link'),
        isNotNull(editionWorkVotes.workUri),
      ),
    );

  const countedLinks = linkRows.reduce((sum, row) => sum + Number(row.c), 0);

  return {
    links: linkRows.map((row) => ({ workUri: row.workUri as string, count: Number(row.c) })),
    unlinkCount: Number(unlinkRow?.c ?? 0),
    ignoredUnknownWork: Number(totalLinkRow?.c ?? 0) - countedLinks,
  };
}

/** Insert or replace a voter's vote. One row per (edition, voter). */
export async function upsertVote(
  vote: EditionWorkVote,
  now: Date = new Date(),
  db: DbExecutor = defaultDb,
): Promise<void> {
  const values = {
    editionUri: vote.editionUri,
    voterDid: vote.voterDid,
    action: vote.action,
    workUri: vote.workUri ?? null,
    workCid: vote.workCid ?? null,
    recordUri: vote.recordUri,
    updatedAt: now,
  };
  await db
    .insert(editionWorkVotes)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [editionWorkVotes.editionUri, editionWorkVotes.voterDid],
      set: {
        action: values.action,
        workUri: values.workUri,
        workCid: values.workCid,
        recordUri: values.recordUri,
        updatedAt: now,
      },
    });
}

/**
 * Apply a record delivered by TAP (or a webhook) to the vote table. Returns the
 * edition the vote belongs to, or null when the record is not a valid vote.
 * Idempotent: redelivery of the same record is a no-op update.
 */
export async function ingestVoteRecord(
  uri: string,
  did: string,
  value: Record<string, unknown>,
  db: DbExecutor = defaultDb,
): Promise<string | null> {
  const vote = parseEditionWorkVote(uri, did, value);
  if (!vote) return null;
  await upsertVote(vote, new Date(), db);
  return vote.editionUri;
}

/** Remove a vote when its underlying record is deleted. Returns the edition. */
export async function forgetVoteByRecordUri(
  recordUri: string,
  db: DbExecutor = defaultDb,
): Promise<string | null> {
  const [row] = await db
    .delete(editionWorkVotes)
    .where(eq(editionWorkVotes.recordUri, recordUri))
    .returning({ editionUri: editionWorkVotes.editionUri });
  return row?.editionUri ?? null;
}

export interface AppliedConsensus {
  decision: ConsensusDecision;
  workUri: string | null;
  workCid: string | null;
  changed: boolean;
}

/**
 * Recompute the tally for one edition and, if consensus says so, rewrite the
 * canonical `editions.work_uri`. The work's own CID is used (never the CID from
 * the vote payload, which may be stale), so the row always matches `works`.
 */
export async function applyConsensus(
  editionUri: string,
  threshold: number = consensusThreshold(),
  db: DbExecutor = defaultDb,
): Promise<AppliedConsensus> {
  const [edition] = await db
    .select({ workUri: editions.workUri, workCid: editions.workCid })
    .from(editions)
    .where(eq(editions.uri, editionUri));
  if (!edition) {
    return { decision: { action: 'none', reason: 'no-votes' }, workUri: null, workCid: null, changed: false };
  }

  const tally = await tallyVotes(editionUri, db);
  const decision = decideConsensus(tally, edition.workUri, threshold);

  if (decision.action === 'none') {
    return {
      decision,
      workUri: edition.workUri,
      workCid: edition.workCid,
      changed: false,
    };
  }

  if (decision.action === 'unlink') {
    await db
      .update(editions)
      .set({ workUri: null, workCid: null, workLinkSource: LINK_SOURCE_CONSENSUS })
      .where(eq(editions.uri, editionUri));
    return { decision, workUri: null, workCid: null, changed: true };
  }

  const [work] = await db
    .select({ uri: works.uri, cid: works.cid })
    .from(works)
    .where(eq(works.uri, decision.workUri));
  if (!work) {
    // The work disappeared between tally and apply; leave the catalog alone.
    return { decision, workUri: edition.workUri, workCid: edition.workCid, changed: false };
  }

  const changed = edition.workUri !== work.uri || edition.workCid !== work.cid;
  await db
    .update(editions)
    .set({
      workUri: work.uri,
      workCid: work.cid,
      workLinkSource: LINK_SOURCE_CONSENSUS,
    })
    .where(eq(editions.uri, editionUri));

  return { decision, workUri: work.uri, workCid: work.cid, changed };
}

export interface EditionWorkStatus {
  editionUri: string;
  workUri: string | null;
  workCid: string | null;
  source: string | null;
  tally: VoteTally;
  threshold: number;
  decision: ConsensusDecision;
  /** The viewer's own vote, when they are signed in. */
  myVote: { action: VoteAction; workUri: string | null } | null;
}

export async function getEditionWorkStatus(
  editionUri: string,
  viewerDid: string | null = null,
  threshold: number = consensusThreshold(),
  db: DbExecutor = defaultDb,
): Promise<EditionWorkStatus | null> {
  const [edition] = await db
    .select({ workUri: editions.workUri, workCid: editions.workCid, source: editions.workLinkSource })
    .from(editions)
    .where(eq(editions.uri, editionUri));
  if (!edition) return null;

  const tally = await tallyVotes(editionUri, db);

  let myVote: EditionWorkStatus['myVote'] = null;
  if (viewerDid) {
    const [row] = await db
      .select({ action: editionWorkVotes.action, workUri: editionWorkVotes.workUri })
      .from(editionWorkVotes)
      .where(
        and(eq(editionWorkVotes.editionUri, editionUri), eq(editionWorkVotes.voterDid, viewerDid)),
      );
    if (row) myVote = { action: row.action, workUri: row.workUri };
  }

  return {
    editionUri,
    workUri: edition.workUri,
    workCid: edition.workCid,
    source: edition.source,
    tally,
    threshold,
    decision: decideConsensus(tally, edition.workUri, threshold),
    myVote,
  };
}
