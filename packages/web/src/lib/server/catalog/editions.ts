
import { likePattern } from './sql.ts';
import {
  EDITION_COLUMNS,
  EDITION_COVERS_JOIN,
  EDITION_SHAPE_JOIN,
  hydrate,
  type EditionQueryable,
  type EditionResults,
  type EditionRow,
  type Identifier
} from './edition-view.ts';

export type {
  ContributorView,
  EditionResults,
  EditionView,
  Identifier,
  PublisherView,
  SeriesView
} from './edition-view';

/**
 * Result ordering for `searchEditions`.
 *
 * `relevance` is the lexicon's provider-defined ranking; `title` and
 * `publishedYear` are local extensions over it.
 */

export type EditionSortOrder = 'asc' | 'desc';
export type EditionSort = 'relevance' | 'title' | 'publishedYear';


/**
 * The `sort` vocabulary both edition listings accept.
 *
 * `relevance` means "this method's own order": the ranking below for a search,
 * newest-first for a contributor listing. Sharing the vocabulary keeps the two
 * surfaces describing the same three choices while each keeps its own default.
 */
export const EDITION_SORTS: Readonly<Record<EditionSort, true>> = {
  relevance: true,
  title: true,
  publishedYear: true
};

export const EDITION_SORT_ORDERS: Readonly<Record<EditionSortOrder, true>> = {
  asc: true,
  desc: true
};

/** A validated order pair, or the message a 400 should carry. */
export type EditionOrderParams =
  | { sort: EditionSort; order: EditionSortOrder }
  | { error: string };

/**
 * Validate `sort`/`order` for any edition listing.
 *
 * One implementation for both surfaces, so `searchEditions` and
 * `listEditionsByContributor` cannot drift in what they accept or in how the
 * default reads.
 */
export function parseEditionOrder(input: {
  sort?: string | null;
  order?: string | null;
}): EditionOrderParams {
  const sort = input.sort ?? 'relevance';
  const order = input.order ?? 'asc';
  if (!Object.hasOwn(EDITION_SORTS, sort)) {
    return { error: `sort must be one of ${Object.keys(EDITION_SORTS).join(', ')}` };
  }
  if (!Object.hasOwn(EDITION_SORT_ORDERS, order)) {
    return { error: `order must be one of ${Object.keys(EDITION_SORT_ORDERS).join(', ')}` };
  }
  return { sort: sort as EditionSort, order: order as EditionSortOrder };
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
  sort?: EditionSort;
  order?: EditionSortOrder;
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
}, pool: EditionQueryable): Promise<EditionResults> {
  const params: Array<string | number> = [];
  const push = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const matches = identifierMatch(input.identifiers, (value) => push(value));
  const limit = push(input.limit + 1);
  const offset = push(input.offset);

  const page = await pool.query<EditionRow>(
    `WITH matches AS (
       SELECT DISTINCT i.edition_uri FROM edition_identifiers i WHERE ${matches}
     )
     SELECT ${EDITION_COLUMNS}
     FROM editions e JOIN matches m ON m.edition_uri = e.uri
     ${EDITION_SHAPE_JOIN}
     ${EDITION_COVERS_JOIN}
     ORDER BY e.indexed_at ASC, e.uri ASC
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

export async function searchEditions(input: {
  q?: string;
  title?: string;
  author?: string;
  /** Union language claim, matched on the primary subtag; absent means no filter. */
  language?: string;
  identifiers: Identifier[];
  offset: number;
  limit: number;
  sort?: EditionSort;
  order?: EditionSortOrder;
  /** Public origin for `/api/covers` URLs; absent keeps provider URLs. */
  coversBaseUrl?: string;
}, pool: EditionQueryable): Promise<EditionResults> {
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
      `SELECT i.edition_uri AS edition_uri, 0 AS rank
         FROM edition_identifiers i
        WHERE ${identifierMatch(input.identifiers, push)}`
    );
    rankedHint = true;
  }

  if (input.title) {
    const pattern = push(likePattern(input.title));
    branches.push(
      `SELECT e.uri AS edition_uri, 1 AS rank FROM editions e WHERE e.title ILIKE ${pattern}`
    );
    rankedHint = true;
  }

  if (input.author) {
    const pattern = push(likePattern(input.author));
    branches.push(
      `SELECT ec.edition_uri, 2 AS rank FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE c.name ILIKE ${pattern}`
    );
    rankedHint = true;
  }

  if (input.q) {
    const pattern = push(likePattern(input.q));
    // The broad text match was an `OR` of these four branches; each one is
    // served by a trigram index of its own.
    branches.push(
      `SELECT e.uri AS edition_uri, 3 AS rank FROM editions e WHERE e.title ILIKE ${pattern}`,
      `SELECT s.edition_uri, 3 AS rank FROM edition_identifier_shape s
        WHERE coalesce(s.description, '') ILIKE ${pattern}`,
      `SELECT ec.edition_uri, 3 AS rank FROM edition_contributors ec
         JOIN contributors c ON c.id = ec.contributor_id
        WHERE c.name ILIKE ${pattern}`,
      `SELECT i.edition_uri, 3 AS rank FROM edition_identifiers i
        WHERE i.value ILIKE ${pattern}`
    );
  }

  // A language is a filter, not a hint: it is ANDed with the match set.
  const where = input.language ? `WHERE ${editionLanguageClause(input.language, push)}` : '';

  // Local ranking is deliberately simple and stable: exact identifier matches
  // first, then title matches, then author matches, then broad text matches. A
  // body with none of the three ranked hints has no ranking key at all, so its
  // page stays in recency order.
  const relevanceOrder = rankedHint
    ? 'r.rank, e.indexed_at DESC, e.uri ASC'
    : 'e.indexed_at DESC, e.uri ASC';

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
       SELECT edition_uri, min(rank) AS rank FROM candidates GROUP BY edition_uri
     )
     `
      : '';
  const from =
    branches.length > 0 ? 'editions e JOIN ranked r ON r.edition_uri = e.uri' : 'editions e';

  const page = await pool.query<EditionRow>(
    `${cte}SELECT ${EDITION_COLUMNS}
     FROM ${from}
     ${EDITION_SHAPE_JOIN}
     ${EDITION_COVERS_JOIN}
     ${where}
     ORDER BY ${ordering}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const rows = page.rows.slice(0, input.limit);

  // See `resolveEditions`: a short first page is the whole match set. The count
  // re-runs the same predicate over the catalogue, so it is only paid for a
  // page that could have more behind it.
  const counted =
    input.offset === 0 && rows.length === input.limit
      ? await pool.query<{ n: number }>(
          `${cte}SELECT count(*)::int AS n
             FROM ${from}
             ${EDITION_SHAPE_JOIN}
             ${where}`,
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
