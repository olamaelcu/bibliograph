import { catalogPool } from './db';
import { likePattern } from './sql';
import {
  EDITION_COLUMNS,
  EDITION_SHAPE_JOIN,
  hydrate,
  type EditionResults,
  type EditionRow,
  type Identifier
} from './edition-view';

export type {
  ContributorView,
  EditionResults,
  EditionView,
  Identifier,
  PublisherView,
  SeriesView
} from './edition-view';

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
}): Promise<EditionResults> {
  const pool = catalogPool();
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
  const items = await hydrate(pool, rows);

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
  identifiers: Identifier[];
  offset: number;
  limit: number;
}): Promise<EditionResults> {
  const pool = catalogPool();
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

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' OR ')}` : '';

  // Local ranking is deliberately simple and stable: exact identifier matches
  // first, then title matches, then author matches, then broad text matches.
  const rank = (clause: string | undefined, value: number): string =>
    clause ? `WHEN ${clause} THEN ${value}` : '';
  const whens = [rank(identifierClause, 0), rank(titleClause, 1), rank(authorClause, 2)].filter(
    Boolean
  );
  const rankCase = whens.length > 0 ? `CASE ${whens.join(' ')} ELSE 3 END` : '3';

  const limit = push(input.limit + 1);
  const offset = push(input.offset);

  const pagePromise = pool.query<EditionRow>(
    `SELECT ${EDITION_COLUMNS}
     FROM editions e
     ${EDITION_SHAPE_JOIN}
     ${where}
     ORDER BY ${rankCase}, e.indexed_at DESC, e.uri ASC
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
  const items = await hydrate(pool, rows);

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(counted ? { total: counted.rows[0]?.n ?? 0 } : {})
  };
}
