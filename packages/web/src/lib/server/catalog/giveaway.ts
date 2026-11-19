/**
 * `net.olamaelcu.livtet.biblio.giveaway.*` — the three reads over the activity
 * index.
 *
 * A giveaway is a record in the author's own repo and an entry is a record in
 * each entrant's own repo, so the index is the only place the pair is visible
 * together and there is no table to keep in step. `happyview_records` stores the
 * record as `text`, so every field read casts to `jsonb` first — the same shape
 * `feeds/query.ts` and `happyview/sql/indexes.sql` use.
 *
 * Counts are of **distinct DIDs**, not of records: a reader who wrote two entries
 * (only possible through a race, since the app checks the index first) is one
 * entrant, and the draw's winner list is a set of DIDs. Counting records instead
 * would make the card, the report and the draw disagree.
 *
 * Pages use an offset cursor and a `limit + 1` probe row, the idiom
 * `listEditionsByContributor` uses: giveaways order by `createdAt DESC, uri DESC`
 * and entries by `createdAt ASC, uri ASC`, so a single-column keyset would be
 * wrong.
 */

import {
  EntityUriError,
  parseEntityUri,
  type EntityQueryable
} from './entities.ts';
import { encodeOffsetCursor, MAX_OFFSET } from './sql.ts';

export const GIVEAWAY_LIST = 'net.olamaelcu.livtet.biblio.giveaway.listGiveaways';
export const GIVEAWAY_ENTRIES = 'net.olamaelcu.livtet.biblio.giveaway.listEntries';
export const GIVEAWAY_REPORT = 'net.olamaelcu.livtet.biblio.giveaway.getReport';
export const GIVEAWAY_EVENT_COLLECTION = 'net.olamaelcu.livtet.biblio.giveaway.event';
export const GIVEAWAY_ENTRY_COLLECTION = 'net.olamaelcu.livtet.biblio.giveaway.entry';
export const BOOK_STATUS_COLLECTION = 'net.olamaelcu.livtet.biblio.bookStatus';
export const SHELF_ITEM_COLLECTION = 'net.olamaelcu.livtet.biblio.shelfItem';
export const BOOK_REVIEW_COLLECTION = 'community.lexicon.media.book.review';
export const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

export type GiveawayDraw = {
  drawnAt: string;
  seed: string;
  winners: string[];
};

export type GiveawayView = {
  uri: string;
  cid: string;
  author: string;
  edition: string;
  title: string;
  coverUrl?: string;
  prizeType: string;
  prizeQuantity: number;
  countries: string[];
  rulesText: string;
  opensAt: string;
  closesAt: string;
  closingNote?: string;
  createdAt: string;
  /** Distinct entrants so far. */
  entries: number;
  draw?: GiveawayDraw;
};

export type GiveawayEntryView = {
  uri: string;
  did: string;
  country?: string;
  createdAt: string;
};

export type GiveawayReport = {
  giveaway: string;
  entries: number;
  shelved: number;
  read: number;
  reviewed: number;
  byCountry: { country: string | null; count: number }[];
};

export type GiveawayPage = {
  giveaways: GiveawayView[];
  cursor?: string;
};

export type EntryPage = {
  entries: GiveawayEntryView[];
  cursor?: string;
};

/** A record as the index holds it: the stored JSON, cast out of `text`. */
type StoredRecord = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * One giveaway row, or `null` when the stored record is not the shape the
 * lexicon describes.
 *
 * A row the index holds but that fails here is skipped rather than answered as a
 * half-filled object: every field below is required by the lexicon, so a record
 * missing one is a corrupt index entry, and a card that renders `undefined` is
 * worse than a card that is absent. Returned `null`, the caller filters it out.
 */
function giveawayOf(row: {
  uri: string;
  cid: string;
  author: string;
  record: unknown;
  entries: unknown;
  drawn_at: unknown;
  seed: unknown;
  winners: unknown;
}): GiveawayView | null {
  const record = row.record as StoredRecord | null;
  if (record === null || typeof record !== 'object') return null;

  const edition = text(record.edition);
  const title = text(record.title);
  const prizeType = text(record.prizeType);
  const prizeQuantity = integer(record.prizeQuantity);
  const rulesText = typeof record.rulesText === 'string' ? record.rulesText : undefined;
  const opensAt = text(record.opensAt);
  const closesAt = text(record.closesAt);
  const createdAt = text(record.createdAt);
  const entries = integer(row.entries);
  if (
    edition === undefined ||
    title === undefined ||
    prizeType === undefined ||
    prizeQuantity === undefined ||
    rulesText === undefined ||
    opensAt === undefined ||
    closesAt === undefined ||
    createdAt === undefined ||
    entries === undefined
  ) {
    return null;
  }

  const view: GiveawayView = {
    uri: row.uri,
    cid: row.cid,
    author: row.author,
    edition,
    title,
    prizeType,
    prizeQuantity,
    countries: strings(record.countries),
    rulesText,
    opensAt,
    closesAt,
    createdAt,
    entries
  };
  const coverUrl = text(record.coverUrl);
  if (coverUrl) view.coverUrl = coverUrl;
  const closingNote = text(record.closingNote);
  if (closingNote) view.closingNote = closingNote;

  // A draw row exists exactly when the author concluded the giveaway; the record
  // itself only carries a `closingNote`, never the result.
  const drawnAt =
    row.drawn_at instanceof Date ? row.drawn_at.toISOString() : text(row.drawn_at);
  const seed = text(row.seed);
  if (drawnAt !== undefined && seed !== undefined) {
    view.draw = { drawnAt, seed, winners: strings(row.winners) };
  }
  return view;
}

function normalizeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const bounded = Math.trunc(limit);
  if (bounded < 1) return 1;
  return bounded > max ? max : bounded;
}

/** Offset from an opaque cursor; `0` for absent or malformed, like every other pager. */
export function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return 0;
    if (!('o' in parsed)) return 0;
    const value = parsed.o;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? Math.min(value, MAX_OFFSET)
      : 0;
  } catch {
    return 0;
  }
}

/** Cursor for the page after this one, when the probe row says there is one. */
function nextCursor(offset: number, limit: number, hasMore: boolean): string | undefined {
  return hasMore ? encodeOffsetCursor(offset + limit) : undefined;
}

const GIVEAWAY_COLUMNS = `r.uri, r.cid, r.did AS author, r.record::jsonb AS record,
       (SELECT count(DISTINCT e.did)::int
          FROM happyview.happyview_records e
         WHERE e.collection = '${GIVEAWAY_ENTRY_COLLECTION}'
           AND e.record::jsonb->'giveaway'->>'uri' = r.uri) AS entries,
       d.drawn_at, d.seed, d.winners`;

const GIVEAWAY_FROM = `happyview.happyview_records r
       LEFT JOIN giveaway_draws d ON d.giveaway = r.uri`;

/**
 * List giveaways, newest first.
 *
 * Every filter is optional and they compose. `status: 'open'` means
 * `opensAt <= now < closesAt`; `'closed'` is the complement, which includes a
 * giveaway whose record the author has since deleted only in the sense that it
 * is no longer listed at all — a delete removes the row from the index.
 *
 * An unknown `uri` answers an empty list, not `RecordNotFound`: the book page
 * asks about whatever it just learned of, and a 404 there would fail a render.
 */
export async function listGiveaways(
  pool: EntityQueryable,
  params: {
    uri?: string;
    author?: string;
    edition?: string;
    status?: 'open' | 'closed';
    limit?: number;
    cursor?: string;
  }
): Promise<GiveawayPage> {
  if (params.uri !== undefined && parseEntityUri(params.uri, GIVEAWAY_EVENT_COLLECTION) === null) {
    throw new EntityUriError('`uri` must be a giveaway record at-uri');
  }
  if (params.edition !== undefined && parseEntityUri(params.edition, EDITION_COLLECTION) === null) {
    throw new EntityUriError('`edition` must be an edition record at-uri');
  }
  if (params.author !== undefined && !DID.test(params.author)) {
    throw new EntityUriError('`author` must be a DID');
  }

  const limit = normalizeLimit(params.limit, 50, 50);
  const offset = offsetOf(params.cursor);
  const values: unknown[] = [GIVEAWAY_EVENT_COLLECTION];
  const where = ['r.collection = $1'];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (params.uri !== undefined) where.push(`r.uri = ${push(params.uri)}`);
  if (params.author !== undefined) where.push(`r.did = ${push(params.author)}`);
  if (params.edition !== undefined) {
    where.push(`r.record::jsonb->>'edition' = ${push(params.edition)}`);
  }
  if (params.status !== undefined) {
    // Cast rather than compare as text: `now()::text` is `2026-11-19 01:00:49+00`
    // while a record holds `2026-11-19T01:00:49.000Z`, and ' ' sorts before 'T',
    // so a text comparison would call every giveaway closed.
    const isOpen = `(r.record::jsonb->>'opensAt')::timestamptz <= now()
        AND (r.record::jsonb->>'closesAt')::timestamptz > now()`;
    where.push(params.status === 'open' ? `(${isOpen})` : `NOT (${isOpen})`);
  }

  const result = await pool.query(
    `SELECT ${GIVEAWAY_COLUMNS}
       FROM ${GIVEAWAY_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY r.record::jsonb->>'createdAt' DESC, r.uri DESC
      LIMIT ${push(limit + 1)} OFFSET ${push(offset)}`,
    values
  );

  const rows = result.rows as Parameters<typeof giveawayOf>[0][];
  const hasMore = rows.length > limit;
  const giveaways = rows
    .slice(0, limit)
    .map(giveawayOf)
    .filter((view): view is GiveawayView => view !== null);

  const page: GiveawayPage = { giveaways };
  const cursor = nextCursor(offset, limit, hasMore);
  if (cursor !== undefined) page.cursor = cursor;
  return page;
}

/** One giveaway by at-uri, or `null`. The detail page's single read. */
export async function getGiveaway(
  pool: EntityQueryable,
  uri: string
): Promise<GiveawayView | null> {
  const page = await listGiveaways(pool, { uri, limit: 1 });
  return page.giveaways[0] ?? null;
}

/**
 * The entries into one giveaway, oldest first — the order the draw draws from,
 * so the author's page and the winners list read the same way.
 */
export async function listEntries(
  pool: EntityQueryable,
  params: { giveaway: string; limit?: number; cursor?: string }
): Promise<EntryPage> {
  if (parseEntityUri(params.giveaway, GIVEAWAY_EVENT_COLLECTION) === null) {
    throw new EntityUriError('`giveaway` must be a giveaway record at-uri');
  }

  const limit = normalizeLimit(params.limit, 50, 500);
  const offset = offsetOf(params.cursor);

  const result = await pool.query(
    `SELECT r.uri, r.did, r.record::jsonb AS record
       FROM happyview.happyview_records r
      WHERE r.collection = $1
        AND r.record::jsonb->'giveaway'->>'uri' = $2
      ORDER BY r.record::jsonb->>'createdAt' ASC, r.uri ASC
      LIMIT $3 OFFSET $4`,
    [GIVEAWAY_ENTRY_COLLECTION, params.giveaway, limit + 1, offset]
  );

  const rows = result.rows as { uri: string; did: string; record: StoredRecord }[];
  const entries: GiveawayEntryView[] = rows.slice(0, limit).map((row) => {
    const view: GiveawayEntryView = {
      uri: row.uri,
      did: row.did,
      createdAt: text(row.record?.createdAt) ?? new Date(0).toISOString()
    };
    const country = text(row.record?.country);
    if (country) view.country = country;
    return view;
  });

  const page: EntryPage = { entries };
  const cursor = nextCursor(offset, limit, rows.length > limit);
  if (cursor !== undefined) page.cursor = cursor;
  return page;
}

/**
 * How many entrants went on to shelve, read and review the edition.
 *
 * Aggregate counts only: this method never names an entrant, which is what makes
 * it safe to show an author who also sees the entrant list through `listEntries`
 * — those two differ only in how much the caller asks for.
 *
 * `shelved` is any of the three row kinds (a `bookStatus`, a `shelfItem` or a
 * review) because a reader who reviews without shelving still engaged with the
 * book, and `read` is a `bookStatus` whose `metadata.status` is `read`.
 */
export async function getGiveawayReport(
  pool: EntityQueryable,
  giveaway: string,
  edition: string
): Promise<GiveawayReport> {
  const result = await pool.query(
    `WITH entrants AS (
       SELECT DISTINCT e.did
         FROM happyview.happyview_records e
        WHERE e.collection = $1
          AND e.record::jsonb->'giveaway'->>'uri' = $2
     ),
     activity AS (
       SELECT did,
              bool_or(kind = 'read') AS has_read,
              bool_or(kind = 'review') AS has_review
         FROM (
           SELECT s.did,
                  CASE WHEN s.record::jsonb->'metadata'->>'status' = 'read'
                       THEN 'read' ELSE 'status' END AS kind
             FROM happyview.happyview_records s
            WHERE s.collection = $3
              AND s.record::jsonb->'book'->>'uri' = $4
           UNION ALL
           SELECT s.did, 'item'
             FROM happyview.happyview_records s
            WHERE s.collection = $5
              AND s.record::jsonb->'book'->>'uri' = $4
           UNION ALL
           SELECT s.did, 'review'
             FROM happyview.happyview_records s
            WHERE s.collection = $6
              AND s.record::jsonb->>'subjectRecord' = $4
         ) kinds
        GROUP BY did
     )
     SELECT (SELECT count(*)::int FROM entrants) AS entries,
            (SELECT count(*)::int
               FROM entrants e JOIN activity a ON a.did = e.did) AS shelved,
            (SELECT count(*)::int
               FROM entrants e JOIN activity a ON a.did = e.did
              WHERE a.has_read) AS read,
            (SELECT count(*)::int
               FROM entrants e JOIN activity a ON a.did = e.did
              WHERE a.has_review) AS reviewed,
            (SELECT coalesce(json_agg(per_country ORDER BY per_country.count DESC,
                                                       per_country.country ASC),
                             '[]'::json)
               FROM (SELECT e.record::jsonb->>'country' AS country,
                            count(DISTINCT e.did)::int AS count
                       FROM happyview.happyview_records e
                      WHERE e.collection = $1
                        AND e.record::jsonb->'giveaway'->>'uri' = $2
                      GROUP BY 1) per_country) AS by_country`,
    [
      GIVEAWAY_ENTRY_COLLECTION,
      giveaway,
      BOOK_STATUS_COLLECTION,
      edition,
      SHELF_ITEM_COLLECTION,
      BOOK_REVIEW_COLLECTION
    ]
  );

  const row = result.rows[0] as
    | {
        entries: unknown;
        shelved: unknown;
        read: unknown;
        reviewed: unknown;
        by_country: unknown;
      }
    | undefined;

  const byCountry = Array.isArray(row?.by_country)
    ? (row.by_country as { country: unknown; count: unknown }[]).map((entry) => ({
        country: text(entry.country) ?? null,
        count: integer(entry.count) ?? 0
      }))
    : [];

  return {
    giveaway,
    entries: integer(row?.entries) ?? 0,
    shelved: integer(row?.shelved) ?? 0,
    read: integer(row?.read) ?? 0,
    reviewed: integer(row?.reviewed) ?? 0,
    byCountry
  };
}
