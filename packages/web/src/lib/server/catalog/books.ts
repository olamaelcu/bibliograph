
import { encodeKeysetCursor, likePattern } from './sql.ts';
import {
  BOOK_COLUMNS,
  BOOK_COVERS_JOIN,
  BOOK_SHAPE_JOIN,
  hydrate,
  type BookQueryable,
  type BookResults,
  type BookRow,
  type BookView,
  type Identifier
} from './book-view.ts';

export type {
  ContributorView,
  BookResults,
  BookView,
  Identifier,
  PublisherView,
  SeriesView
} from './book-view';

/**
 * Result ordering for `searchEditions`.
 *
 * `relevance` is the lexicon's provider-defined ranking; `title` and
 * `publishedYear` are local extensions over it.
 */

export type BookSortOrder = 'asc' | 'desc';
export type BookSort = 'relevance' | 'title' | 'publishedYear';


/**
 * The `sort` vocabulary both edition listings accept.
 *
 * `relevance` means "this method's own order": the ranking below for a search,
 * newest-first for a contributor listing. Sharing the vocabulary keeps the two
 * surfaces describing the same three choices while each keeps its own default.
 */
export const EDITION_SORTS: Readonly<Record<BookSort, true>> = {
  relevance: true,
  title: true,
  publishedYear: true
};

export const EDITION_SORT_ORDERS: Readonly<Record<BookSortOrder, true>> = {
  asc: true,
  desc: true
};

/** A validated order pair, or the message a 400 should carry. */
export type BookOrderParams =
  | { sort: BookSort; order: BookSortOrder }
  | { error: string };

/**
 * Validate `sort`/`order` for any edition listing.
 *
 * One implementation for both surfaces, so `searchEditions` and
 * `listEditionsByContributor` cannot drift in what they accept or in how the
 * default reads.
 */
export function parseBookOrder(input: {
  sort?: string | null;
  order?: string | null;
}): BookOrderParams {
  const sort = input.sort ?? 'relevance';
  const order = input.order ?? 'asc';
  if (!Object.hasOwn(EDITION_SORTS, sort)) {
    return { error: `sort must be one of ${Object.keys(EDITION_SORTS).join(', ')}` };
  }
  if (!Object.hasOwn(EDITION_SORT_ORDERS, order)) {
    return { error: `order must be one of ${Object.keys(EDITION_SORT_ORDERS).join(', ')}` };
  }
  return { sort: sort as BookSort, order: order as BookSortOrder };
}

/**
 * The union-claim language filter, shared by every edition listing.
 *
 * The claim holds whatever the source supplied — providers give ISO 639-2
 * (`eng`), curation gives BCP 47 (`en`, `en-US`) — so the match is on the
 * primary subtag, case-insensitively: `en` finds `en` and `en-US`, `eng` finds
 * `eng`.
 */
export function editionLanguageClause(
  language: string,
  push: (value: string) => string
): string {
  const value = push(language.toLowerCase());
  return `split_part(lower(s.language), '-', 1) = split_part(${value}, '-', 1)`;
}

/**
 * ORDER BY for one page of either listing.
 *
 * `fallback` is the caller's own order, used when no `sort` is asked for, so
 * the shared vocabulary never overrides a method's default. A `published_date`
 * that is not a strict `YYYY[-MM[-DD]]` value has no year and sorts last in
 * either direction, so an unknown year never leads a list. `uri` breaks every
 * tie, so pages cannot shuffle.
 */
export function editionOrderBy(input: {
  sort?: BookSort;
  order?: BookSortOrder;
  fallback: string;
}): string {
  const direction = input.order === 'desc' ? 'DESC' : 'ASC';
  if (input.sort === 'title') return `lower(e.title) ${direction}, e.uri ASC`;
  if (input.sort === 'publishedYear') {
    return (
      `(CASE WHEN s.published_date ~ '^[0-9]{4}' ` +
      `THEN substring(s.published_date from 1 for 4)::int END) ${direction} NULLS LAST, ` +
      `s.published_date ${direction} NULLS LAST, e.uri ASC`
    );
  }
  return input.fallback;
}

/** SQL fragment matching any of the supplied identifier pairs. */
function identifierMatch(
  identifiers: Identifier[],
  push: (value: string) => string
): string {
  const tuples: string[] = [];
  for (const identifier of identifiers) {
    const issuer = push(identifier.issuer);
    const value = push(identifier.value);
    tuples.push(`(${issuer}, ${value})`);
  }
  return `(i.issuer, i.value) IN (${tuples.join(', ')})`;
}

export async function resolveEditions(input: {
  identifiers: Identifier[];
  offset: number;
  limit: number;
  /** Public origin for `/api/covers` URLs; absent keeps provider URLs. */
  coversBaseUrl?: string;
}, pool: BookQueryable): Promise<BookResults> {
  const params: Array<string | number> = [];
  const push = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const matches = identifierMatch(input.identifiers, (value) => push(value));
  const limit = push(input.limit + 1);
  const offset = push(input.offset);

  const page = await pool.query<BookRow>(
    `WITH matches AS (
       SELECT DISTINCT i.edition_uri FROM edition_identifiers i WHERE ${matches}
     )
     SELECT ${BOOK_COLUMNS}
     FROM books e JOIN matches m ON m.edition_uri = e.uri
     ${BOOK_SHAPE_JOIN}
     ${BOOK_COVERS_JOIN}
     ORDER BY m.edition_uri ASC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const rows = page.rows.slice(0, input.limit);

  // A first page shorter than `limit` is the whole match set, so its length is
  // the exact total and the count scan is not worth running. Only a full first
  // page can have more matches behind it.
  const counted =
    input.offset === 0 && rows.length === input.limit
      ? await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT DISTINCT i.edition_uri FROM edition_identifiers i WHERE ${matches}
           ) matched`,
          params.slice(0, params.length - 2)
        )
      : null;
  const items = await hydrate(pool, rows, input.coversBaseUrl ?? '');

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(input.offset === 0 ? { total: counted ? counted.rows[0]?.n ?? 0 : rows.length } : {})
  };
}

/**
 * A page of the catalog's editions, in at-uri order.
 *
 * This is the enumeration surface: `searchEditions` needs a term and
 * `resolveEditions` needs an identifier, so neither can answer "give me
 * everything", which is what a crawl (a sitemap, a mirror) asks for. A page is
 * served by `editions_pkey` alone — no shape or cover join, no hydration — so a
 * whole-catalogue walk is a handful of index scans instead of one query per
 * edition. The keyset cursor resumes after the last uri returned, so inserting
 * a row mid-walk cannot shift a page boundary and make the crawl skip one.
 */
export type BookListing = { uri: string; title: string; indexedAt: string };

export async function listEditions(
  input: { after: string | null; limit: number },
  pool: BookQueryable
): Promise<{ items: BookListing[]; cursor?: string }> {
  const params: Array<string | number> = [];
  const push = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const after = input.after === null ? null : push(input.after);
  const limit = push(input.limit + 1);
  const where = after === null ? '' : `WHERE uri > ${after}`;

  const page = await pool.query<{ uri: string; title: string; indexed_at: Date }>(
    `SELECT uri, title, indexed_at
       FROM books
       ${where}
      ORDER BY uri
      LIMIT ${limit}`,
    params
  );

  const items = page.rows.slice(0, input.limit).map((row) => ({
    uri: row.uri,
    title: row.title,
    indexedAt: new Date(row.indexed_at).toISOString()
  }));
  const last = items.at(-1);
  return {
    items,
    ...(page.rows.length > input.limit && last !== undefined
      ? { cursor: encodeKeysetCursor(last.uri) }
      : {})
  };
}

export async function searchEditions(input: {
  q?: string;
  title?: string;
  author?: string;
  /** Union language claim, matched on the primary subtag; absent means no filter. */
  language?: string;
  identifiers: Identifier[];
  offset: number;
  limit: number;
  sort?: BookSort;
  order?: BookSortOrder;
  /** Public origin for `/api/covers` URLs; absent keeps provider URLs. */
  coversBaseUrl?: string;
}, pool: BookQueryable, hydration: BookQueryable = pool): Promise<BookResults> {
  const params: Array<string | number> = [];
  const push = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Each hint contributes one index-backed set of edition URIs, tagged with the
  // relevance bucket the old `CASE` emitted: 0 exact identifier, 1 title, 2
  // author, 3 broad text. `min(rank)` over an edition's branches reproduces
  // that precedence exactly, and the union of the branches is the same match
  // set the `OR` selected — as a few hundred URIs instead of a catalogue scan
  // with a correlated subplan per row (which no `BitmapOr` can absorb, because
  // two of the four text branches are `EXISTS` subqueries).
  const branches: string[] = [];
  let rankedHint = false;

  if (input.identifiers.length > 0) {
    branches.push(
      `SELECT i.edition_uri AS edition_uri, 0 AS rank, 0::real AS score
         FROM edition_identifiers i
        WHERE ${identifierMatch(input.identifiers, push)}`
    );
    rankedHint = true;
  }

  if (input.title) {
    const pattern = push(likePattern(input.title));
    branches.push(
      `SELECT e.uri AS edition_uri, 1 AS rank, 0::real AS score
         FROM books e WHERE e.title ILIKE ${pattern}`
    );
    rankedHint = true;
  }

  if (input.author) {
    const pattern = push(likePattern(input.author));
    branches.push(
      `SELECT ec.edition_uri, 2 AS rank, 0::real AS score
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE c.name ILIKE ${pattern}`
    );
    rankedHint = true;
  }

  if (input.q) {
    // Free text is one tsvector match per book — title, subtitle, contributors,
    // description and identifier values in one document — ranked by
    // `ts_rank_cd`. It replaces the four trigram `ILIKE` branches that unioned
    // title, description, contributor and identifier matches and then folded
    // them with a hash aggregate: four GIN scans and an aggregate per search
    // became one scan with a real score. See 0027.
    const query = push(input.q);
    const pattern = push(likePattern(input.q));
    branches.push(
      `SELECT bs.uri AS edition_uri, 3 AS rank,
              ts_rank_cd(bs.document, websearch_to_tsquery('english', ${query})) AS score
         FROM book_search bs
        WHERE bs.document @@ websearch_to_tsquery('english', ${query})`,
      // The vector matches whole lexemes (with stemming), which drops the
      // substring behaviour the trigram form had: "Frank Herber" would stop
      // matching "Frank Herbert", and a typed prefix of an ISBN would stop
      // matching its value. Title and identifier values are what callers type
      // into, so their trigram indexes still answer the substring case; the
      // description, which was the expensive trigram scan, is vector-only.
      `SELECT e.uri AS edition_uri, 3 AS rank, 0::real AS score
         FROM books e WHERE e.title ILIKE ${pattern}`,
      `SELECT ec.edition_uri, 3 AS rank, 0::real AS score
         FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE c.name ILIKE ${pattern}`,
      `SELECT i.edition_uri, 3 AS rank, 0::real AS score
         FROM edition_identifiers i WHERE i.value ILIKE ${pattern}`
    );
    rankedHint = true;
  }

  // A language is a filter, not a hint: it is ANDed with the match set.
  const where = input.language ? `WHERE ${editionLanguageClause(input.language, push)}` : '';

  // Local ranking is deliberately simple and stable: exact identifier matches
  // first, then title matches, then author matches, then free text; within the
  // free-text bucket the tsvector score orders, so a title hit outranks a
  // description hit. A body with no hint at all keeps uri order — the primary
  // key, so the page is one index scan instead of a sort of the match set.
  const relevanceOrder = rankedHint ? 'r.rank, r.score DESC, e.uri ASC' : 'e.uri ASC';

  const limit = push(input.limit + 1);
  const offset = push(input.offset);

  // `relevance` keeps this method's ranking; the other two sort the page. The
  // rules live in `editionOrderBy`, shared with the contributor listing.
  const ordering = editionOrderBy({
    sort: input.sort,
    order: input.order,
    fallback: relevanceOrder
  });

  // A body with no hint (`language` only) has no candidate set to narrow to and
  // keeps the catalogue scan. `ranked` folds an edition's branches down to the
  // best rank it earned, so each edition contributes one row.
  const cte =
    branches.length > 0
      ? `WITH candidates AS (
       ${branches.join('\n       UNION ALL\n       ')}
     ), ranked AS (
       SELECT edition_uri, min(rank) AS rank, max(score) AS score
         FROM candidates GROUP BY edition_uri
     )
     `
      : '';
  const from =
    branches.length > 0 ? 'books e JOIN ranked r ON r.edition_uri = e.uri' : 'books e';

  const page = await pool.query<BookRow>(
    `${cte}SELECT ${BOOK_COLUMNS}
     FROM ${from}
     ${BOOK_SHAPE_JOIN}
     ${BOOK_COVERS_JOIN}
     ${where}
     ORDER BY ${ordering}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const rows = page.rows.slice(0, input.limit);

  const items = await hydrate(hydration, rows, input.coversBaseUrl ?? '');

  // A first page shorter than `limit` is the whole match set, so its length is
  // the exact total. A full first page has more behind it but its exact size is
  // not worth a second pass over the same predicate: the `count(*)` re-ran the
  // candidates CTE and the join, and under concurrent traffic it was the
  // statement that hit the search pool's 10 s bound and turned a search into a
  // 503. `total` is therefore omitted on a full page, and the hydration policy
  // treats that omission as "enough matches".
  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(input.offset === 0 && rows.length < input.limit ? { total: rows.length } : {})
  };
}

/**
 * Hydrate one page of edition uris in the order they were ranked by the caller
 * (the external index). Hydration is the same three queries the SQL path runs;
 * only the row selection and its order differ.
 */
export async function editionsByUris(
  uris: string[],
  pool: BookQueryable,
  coversBaseUrl = '',
  hydration: BookQueryable = pool
): Promise<BookView[]> {
  if (uris.length === 0) return [];
  const page = await pool.query<BookRow>(
    `SELECT ${BOOK_COLUMNS}
       FROM books e
       ${BOOK_SHAPE_JOIN}
       ${BOOK_COVERS_JOIN}
      WHERE e.uri = ANY($1::text[])
      ORDER BY array_position($1::text[], e.uri)`,
    [uris]
  );
  return hydrate(hydration, page.rows, coversBaseUrl);
}
