
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
export type EditionSort = 'relevance' | 'title' | 'publishedYear';

export type EditionSortOrder = 'asc' | 'desc';

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

  const pagePromise = pool.query<EditionRow>(
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

  const totalPromise =
    input.offset === 0
      ? pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT DISTINCT i.edition_uri FROM edition_identifiers i WHERE ${matches}
           ) matched`,
          params.slice(0, params.length - 2)
        )
      : null;

  const [page, counted] = await Promise.all([pagePromise, totalPromise]);
  const rows = page.rows.slice(0, input.limit);
  const items = await hydrate(pool, rows, input.coversBaseUrl ?? '');

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(counted ? { total: counted.rows[0]?.n ?? 0 } : {})
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

  const clauses: string[] = [];
  let identifierClause: string | undefined;
  let titleClause: string | undefined;
  let authorClause: string | undefined;
  let textClause: string | undefined;

  if (input.identifiers.length > 0) {
    identifierClause = `EXISTS (
      SELECT 1 FROM edition_identifiers i
      WHERE i.edition_uri = e.uri AND ${identifierMatch(input.identifiers, push)}
    )`;
    clauses.push(identifierClause);
  }

  if (input.title) {
    const pattern = push(likePattern(input.title));
    titleClause = `e.title ILIKE ${pattern}`;
    clauses.push(titleClause);
  }

  if (input.author) {
    const pattern = push(likePattern(input.author));
    authorClause = `EXISTS (
      SELECT 1 FROM edition_contributors ec
      JOIN contributors c ON c.id = ec.contributor_id
      WHERE ec.edition_uri = e.uri AND c.name ILIKE ${pattern}
    )`;
    clauses.push(authorClause);
  }

  if (input.q) {
    const pattern = push(likePattern(input.q));
    textClause = `(
      e.title ILIKE ${pattern}
      OR coalesce(s.description, '') ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM edition_contributors ecq
        JOIN contributors cq ON cq.id = ecq.contributor_id
        WHERE ecq.edition_uri = e.uri AND cq.name ILIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1 FROM edition_identifiers iq
        WHERE iq.edition_uri = e.uri AND iq.value ILIKE ${pattern}
      )
    )`;
    clauses.push(textClause);
  }

  // The hints above are ORed; a language is a filter, so it is ANDed with them
  // and only an edition whose union claim matches it is returned. The claim
  // holds whatever the source supplied — providers give ISO 639-2 (`eng`),
  // curation gives BCP 47 (`en`, `en-US`) — so the match is on the primary
  // subtag, case-insensitively: `en` finds `en` and `en-US`, `eng` finds `eng`.
  const filters: string[] = [];
  if (input.language) {
    const language = push(input.language.toLowerCase());
    filters.push(`split_part(lower(s.language), '-', 1) = split_part(${language}, '-', 1)`);
  }

  const conditions = [
    ...(clauses.length > 0 ? [`(${clauses.join(' OR ')})`] : []),
    ...filters
  ];
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Local ranking is deliberately simple and stable: exact identifier matches
  // first, then title matches, then author matches, then broad text matches.
  const rank = (clause: string | undefined, value: number): string =>
    clause ? `WHEN ${clause} THEN ${value}` : '';
  const whens = [rank(identifierClause, 0), rank(titleClause, 1), rank(authorClause, 2)].filter(
    Boolean
  );
  // No hint means no ranking key: an integer literal here would be read as a
  // select-list position, not a constant.
  const relevanceOrder =
    whens.length > 0
      ? `CASE ${whens.join(' ')} ELSE 3 END, e.indexed_at DESC, e.uri ASC`
      : 'e.indexed_at DESC, e.uri ASC';

  const limit = push(input.limit + 1);
  const offset = push(input.offset);

  // `title` and `publishedYear` are local extensions over the lexicon's
  // provider-defined ranking. A date that is not a strict `YYYY[-MM[-DD]]`
  // value has no year, and sorts last in either direction so an unknown year
  // never leads a list. `uri` breaks every tie, so pages cannot shuffle.
  const direction = input.order === 'desc' ? 'DESC' : 'ASC';
  const ordering =
    input.sort === 'title'
      ? `lower(e.title) ${direction}, e.uri ASC`
      : input.sort === 'publishedYear'
        ? `(CASE WHEN s.published_date ~ '^[0-9]{4}' THEN substring(s.published_date from 1 for 4)::int END) ${direction} NULLS LAST, s.published_date ${direction} NULLS LAST, e.uri ASC`
        : relevanceOrder;

  const pagePromise = pool.query<EditionRow>(
    `SELECT ${EDITION_COLUMNS}
     FROM editions e
     ${EDITION_SHAPE_JOIN}
     ${EDITION_COVERS_JOIN}
     ${where}
     ORDER BY ${ordering}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const totalPromise =
    input.offset === 0
      ? pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM editions e
             ${EDITION_SHAPE_JOIN}
             ${where}`,
          params.slice(0, params.length - 2)
        )
      : null;

  const [page, counted] = await Promise.all([pagePromise, totalPromise]);
  const rows = page.rows.slice(0, input.limit);
  const items = await hydrate(pool, rows, input.coversBaseUrl ?? '');

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(counted ? { total: counted.rows[0]?.n ?? 0 } : {})
  };
}
