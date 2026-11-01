import type { Logger } from 'pino';
import { eq, inArray } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { contributors, editionIsbnEnrichment, editions } from '../db/schema';
import type { EditionRow } from '../db/schema';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { getEditionByRkey, searchEditions as searchOlEditions } from '../api/open-library';
import { getEditionByVolumeId, searchEditions as searchGbEditions } from '../api/google-books';
import type { EditionItem, Identifier } from '../search/types';
import { hasIsbn, isbnFromIdentifier, mergeIsbnIdentifiers } from '../isbn/merge';
import {
  candidateFromEditionItem,
  pruneCandidates,
  type CandidateBook,
  type ScoredCandidate,
  type TargetEdition,
} from '../isbn/prune';
import { isIsbndbRkey, isbnFromIsbndbRkey } from '../isbndb/keys';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';

/**
 * Backfill the ISBN an edition record is missing.
 *
 * Almost every ISBN-less edition in the catalog is an `ol.*` or `gb.*` record,
 * and the authority it was derived from already knows the ISBN — OpenLibrary's
 * edition document carries `isbn_10`/`isbn_13`. That authority refetch is tier
 * 1 and it is deterministic: no matching, no guessing.
 *
 * Tier 2 only runs when the authority has no ISBN to give. It searches
 * OpenLibrary and Google Books, then prunes the candidates down with
 * `pruneCandidates`. It is in **shadow mode**: it records what it would have
 * written (and why the rest were rejected) but never touches the identifiers,
 * because a wrong ISBN silently repoints a reader's shelf at a different
 * physical book.
 */

type Db = typeof defaultDb;

/** Contributor refs, as the records store them. */
type ContributorRef = { uri: string };

/** Everything tier 2 needs; injected so the planner is testable. */
export interface IsbnEnrichmentDeps {
  fetchOlEdition(rkey: string): Promise<EditionItem | null>;
  fetchGbEdition(volumeId: string): Promise<EditionItem | null>;
  searchOl(query: string): Promise<EditionItem[]>;
  searchGb(query: string): Promise<EditionItem[]>;
  /** contributor uri → name, for the refs the planner hands over. */
  authorNames(refs: readonly ContributorRef[]): Promise<Map<string, string>>;
}

export type EnrichmentResultName = 'found' | 'shadow' | 'ambiguous' | 'none' | 'already';

export interface EnrichmentPlan {
  /** `write` only ever comes from tier 1. */
  action: 'already_has_isbn' | 'write' | 'shadow' | 'none';
  result: EnrichmentResultName;
  identifiers?: Identifier[];
  added?: string[];
  candidates?: ScoredCandidate[];
}

/** The authority record the edition was derived from, if the rkey names one. */
async function fetchAuthorityItem(
  row: EditionRow,
  deps: IsbnEnrichmentDeps,
): Promise<EditionItem | null> {
  if (row.rkey.startsWith('ol.')) return deps.fetchOlEdition(row.rkey);
  if (isGbRkey(row.rkey)) return deps.fetchGbEdition(volumeIdFromGbRkey(row.rkey));
  // `isbndb.*` rkeys carry the ISBN themselves; `bh.*` has no per-edition API.
  return null;
}

/**
 * Decide what an edition's enrichment should do, without touching the database.
 *
 * Split out of the job so both tiers can be exercised without network or
 * Postgres: every dependency arrives through `deps`.
 */
export async function planIsbnEnrichment(
  row: EditionRow,
  deps: IsbnEnrichmentDeps,
): Promise<EnrichmentPlan> {
  if (hasIsbn(row.identifiers)) return { action: 'already_has_isbn', result: 'already' };

  // An `isbndb.*` record's rkey is the ISBN; no upstream call is needed.
  if (isIsbndbRkey(row.rkey)) {
    const fromKey = isbnFromIsbndbRkey(row.rkey);
    const merged = mergeIsbnIdentifiers(row.identifiers, [fromKey]);
    if (merged.added.length > 0) {
      return { action: 'write', result: 'found', identifiers: merged.identifiers, added: merged.added };
    }
  }

  const authority = await fetchAuthorityItem(row, deps);
  const authorityIsbns = (authority?.identifiers ?? [])
    .map((identifier) => isbnFromIdentifier(identifier))
    .filter((value): value is string => value !== null);

  if (authorityIsbns.length > 0) {
    const merged = mergeIsbnIdentifiers(row.identifiers, authorityIsbns);
    if (merged.added.length > 0) {
      return { action: 'write', result: 'found', identifiers: merged.identifiers, added: merged.added };
    }
  }

  // ── Tier 2, shadow only ─────────────────────────────────────────────
  const authorRefs: ContributorRef[] = [
    ...(authority?.contributors ?? []),
    ...(row.contributors ?? []),
  ]
    .filter((contribution) => contribution.role === 'author')
    .map((contribution) => ({ uri: contribution.subject?.uri ?? '' }))
    .filter((ref) => ref.uri.length > 0);

  const names = await deps.authorNames(authorRefs).catch(() => new Map<string, string>());
  const target: TargetEdition = {
    // The authority's title is what its own search results are indexed under.
    title: authority?.title ?? row.title,
    authors: [...names.values()],
    publishedYear: authority?.publishedYear ?? row.publishedYear ?? null,
  };

  const candidates: CandidateBook[] = [];
  if (target.title.trim().length > 0) {
    const surname = target.authors[0]?.split(/\s+/).pop() ?? '';
    const olQuery = [`title:"${target.title}"`, surname ? `author:"${surname}"` : ''].filter(Boolean).join(' ');
    const gbQuery = [`intitle:${target.title}`, surname ? `inauthor:${surname}` : ''].filter(Boolean).join(' ');

    const [olHits, gbHits] = await Promise.all([
      deps.searchOl(olQuery).catch(() => []),
      deps.searchGb(gbQuery).catch(() => []),
    ]);

    const candidateRefs: ContributorRef[] = [...olHits, ...gbHits].flatMap((hit) =>
      (hit.contributors ?? []).map((contribution) => ({ uri: contribution.subject?.uri ?? '' })),
    );
    const candidateNames = await deps
      .authorNames(candidateRefs.filter((ref) => ref.uri.length > 0))
      .catch(() => new Map<string, string>());

    for (const hit of olHits) candidates.push(candidateFromEditionItem('openlibrary', hit, candidateNames));
    for (const hit of gbHits) candidates.push(candidateFromEditionItem('googlebooks', hit, candidateNames));
  }

  const pruned = pruneCandidates(target, candidates);
  const recorded = [...pruned.survivors, ...pruned.rejected];
  if (pruned.kind === 'found') return { action: 'shadow', result: 'shadow', candidates: recorded };
  if (pruned.kind === 'ambiguous') return { action: 'none', result: 'ambiguous', candidates: recorded };
  return { action: 'none', result: 'none', candidates: recorded };
}

/** The lexicon-shaped record value, so the CID matches what the API serves. */
function editionValueForCid(row: EditionRow, identifiers: Identifier[]): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.edition' as const,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    place: row.place ?? undefined,
    publishedYear: row.publishedYear ?? undefined,
    language: row.language ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    contributors: row.contributors,
    identifiers,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Wire the real clients, with the job's logger and timeout baked in. */
export function defaultIsbnDeps(
  log: Logger,
  db: Db = defaultDb,
  signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
): IsbnEnrichmentDeps {
  return {
    fetchOlEdition: (rkey) => getEditionByRkey(rkey, log, signal),
    fetchGbEdition: (volumeId) => getEditionByVolumeId(volumeId, log, signal),
    searchOl: async (q) => (await searchOlEditions({ q, limit: 8 }, log, signal)).items,
    searchGb: async (q) => (await searchGbEditions({ q, limit: 8 }, log, signal)).items,
    authorNames: async (refs) => {
      const uris = [...new Set(refs.map((ref) => ref.uri))];
      if (uris.length === 0) return new Map();
      const rows = await db
        .select({ uri: contributors.uri, name: contributors.name })
        .from(contributors)
        .where(inArray(contributors.uri, uris));
      return new Map(rows.map((row) => [row.uri, row.name]));
    },
  };
}

export interface IsbnBackfillOutcome {
  updated: boolean;
  reason: string;
  added?: string[];
}

/**
 * Run one edition through both tiers and persist the outcome.
 *
 * Tier 1 writes identifiers (and recomputes the record CID so clients see a new
 * revision). Tier 2 only records its candidates, which is why `updated` stays
 * false for `shadow`/`ambiguous`/`none` — those rows still get a row in
 * `edition_isbn_enrichment` so the scan stops re-asking upstream for a book that
 * has no ISBN to find.
 */
export async function backfillIsbnForEdition(
  uri: string,
  rkey: string,
  log: Logger,
  db: Db = defaultDb,
  deps?: IsbnEnrichmentDeps,
): Promise<IsbnBackfillOutcome> {
  const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  // Only the catalog's own records are ours to rewrite.
  if (row.did !== process.env.LEX_PUBLISHER_DID && !row.did.startsWith('did:web:')) {
    return { updated: false, reason: 'not_catalog_record' };
  }
  if (row.rkey !== rkey) {
    log.warn({ stage: 'isbn-backfill', uri, rkey, rowRkey: row.rkey }, 'rkey mismatch; using row rkey');
  }

  const plan = await planIsbnEnrichment(row, deps ?? defaultIsbnDeps(log, db));
  if (plan.action === 'already_has_isbn') return { updated: false, reason: 'already_has_isbn' };

  if (plan.action === 'write' && plan.identifiers) {
    const value = editionValueForCid(row, plan.identifiers);
    const cid = (await cidForLex(value as unknown as LexMap)).toString();
    const updated = await db
      .update(editions)
      .set({ identifiers: plan.identifiers, cid, indexedAt: new Date() })
      .where(eq(editions.uri, uri))
      .returning({ uri: editions.uri });
    if (updated.length === 0) return { updated: false, reason: 'update_missed' };
    await recordEnrichment(db, uri, plan);
    log.info({ stage: 'isbn-backfill', uri, added: plan.added, cid }, 'isbn backfilled');
    return { updated: true, reason: 'ok', added: plan.added };
  }

  await recordEnrichment(db, uri, plan);
  if (plan.action === 'shadow') {
    log.info(
      {
        stage: 'isbn-backfill',
        uri,
        result: plan.result,
        candidates: plan.candidates?.filter((candidate) => candidate.accepted),
      },
      'isbn shadow match recorded; nothing written',
    );
  }
  return { updated: false, reason: plan.result };
}

/** Bookkeeping row: what was looked at, and what the tiers concluded. */
async function recordEnrichment(db: Db, uri: string, plan: EnrichmentPlan): Promise<void> {
  const values = {
    uri,
    checkedAt: new Date(),
    result: plan.result,
    candidates: plan.candidates ?? null,
  };
  await db
    .insert(editionIsbnEnrichment)
    .values(values)
    .onConflictDoUpdate({ target: editionIsbnEnrichment.uri, set: values });
}
