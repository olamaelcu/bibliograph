import { catalogPool } from './db';

export type Identifier = {
  issuer: string;
  value: string;
  url?: string;
};

export type ContributorView = {
  name: string;
  role?: string;
  identifiers?: Identifier[];
  ref?: string;
};

export type PublisherView = { name: string; identifiers?: Identifier[] };

export type SeriesView = { name: string; position?: string; display?: string };

export type EditionView = {
  title: string;
  identifiers: Identifier[];
  contributors: ContributorView[];
  createdAt: string;
  coverUrl?: string;
  subtitle?: string;
  language?: string;
  publishedDate?: string;
  publisher?: PublisherView;
  format?: string;
  pages?: number;
  durationSeconds?: number;
  chapters?: number;
  series?: SeriesView;
  bookEdition?: string;
  description?: string;
};

export type EditionResults = { items: EditionView[]; hasMore: boolean; total?: number };

/** A global token for "this value is the atproto URI of the edition". */
export const AT_URI_ISSUER = 'atproto';

type EditionRow = {
  uri: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  published_date: string | null;
  format: string | null;
  pages: number | null;
  duration_seconds: number | null;
  chapters: number | null;
  series: SeriesView | null;
  book_edition: string | null;
  description: string | null;
  cover_url: string | null;
  created_at: Date;
};

type IdentifierRow = { edition_uri: string; issuer: string; value: string };
type ContributorRow = {
  edition_uri: string;
  name: string;
  role: string;
  identifiers: Identifier[] | null;
  ref: string | null;
};
type PublisherRow = { edition_uri: string; name: string; identifiers: Identifier[] | null };

const EDITION_COLUMNS = `
  e.uri, e.title, e.subtitle, e.language, e.published_date, e.format, e.pages,
  e.duration_seconds, e.chapters, e.series, e.book_edition, e.description,
  e.cover_url, e.created_at`;

function atUriIdentifier(uri: string): Identifier {
  return { issuer: AT_URI_ISSUER, value: uri };
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

function editionView(
  row: EditionRow,
  identifiers: IdentifierRow[],
  contributors: ContributorRow[],
  publisher: PublisherRow | undefined
): EditionView {
  // The edition view has no `uri` field, so the record URI travels as an
  // identifier: clients rebuild links such as /book/<did>/<rkey> from it.
  const seen = new Set<string>();
  const bag: Identifier[] = [];
  const stored: Identifier[] = identifiers.map((identifier) => ({
    issuer: identifier.issuer,
    value: identifier.value
  }));
  for (const identifier of [atUriIdentifier(row.uri), ...stored]) {
    const key = `${identifier.issuer}\u0000${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bag.push(identifier);
  }

  const view: EditionView = {
    title: row.title,
    identifiers: bag,
    contributors: contributors
      .filter((contributor) => contributor.name !== '')
      .map((contributor) => ({
        name: contributor.name,
        role: contributor.role,
        ...(contributor.identifiers?.length ? { identifiers: contributor.identifiers } : {}),
        ...(contributor.ref ? { ref: contributor.ref } : {})
      })),
    createdAt: new Date(row.created_at).toISOString()
  };

  const coverUrl = optional(row.cover_url);
  if (coverUrl) view.coverUrl = coverUrl;
  const subtitle = optional(row.subtitle);
  if (subtitle) view.subtitle = subtitle;
  const language = optional(row.language);
  if (language) view.language = language;
  const publishedDate = optional(row.published_date);
  if (publishedDate) view.publishedDate = publishedDate;
  const format = optional(row.format);
  if (format) view.format = format;
  const pages = optional(row.pages);
  if (pages !== undefined) view.pages = pages;
  const durationSeconds = optional(row.duration_seconds);
  if (durationSeconds !== undefined) view.durationSeconds = durationSeconds;
  const chapters = optional(row.chapters);
  if (chapters !== undefined) view.chapters = chapters;
  if (row.series && typeof row.series.name === 'string' && row.series.name !== '') {
    view.series = {
      name: row.series.name,
      ...(typeof row.series.position === 'string' ? { position: row.series.position } : {}),
      ...(typeof row.series.display === 'string' ? { display: row.series.display } : {})
    };
  }
  const bookEdition = optional(row.book_edition);
  if (bookEdition) view.bookEdition = bookEdition;
  const description = optional(row.description);
  if (description) view.description = description;
  if (publisher) {
    view.publisher = {
      name: publisher.name,
      ...(publisher.identifiers?.length ? { identifiers: publisher.identifiers } : {})
    };
  }

  return view;
}

async function hydrate(rows: EditionRow[]): Promise<EditionView[]> {
  if (rows.length === 0) return [];
  const pool = catalogPool();
  const uris = rows.map((row) => row.uri);

  const [identifierResult, contributorResult, publisherResult] = await Promise.all([
    pool.query<IdentifierRow>(
      `SELECT edition_uri, issuer, value FROM edition_identifiers
       WHERE edition_uri = ANY($1) ORDER BY issuer, value`,
      [uris]
    ),
    pool.query<ContributorRow>(
      `SELECT ec.edition_uri, c.name, ec.role, c.identifiers, ec.ref
       FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
       WHERE ec.edition_uri = ANY($1)
       ORDER BY ec.edition_uri, ec.position`,
      [uris]
    ),
    pool.query<PublisherRow>(
      `SELECT ep.edition_uri, p.name, p.identifiers
       FROM edition_publishers ep
       JOIN publishers p ON p.id = ep.publisher_id
       WHERE ep.edition_uri = ANY($1)
       ORDER BY ep.edition_uri, ep.position`,
      [uris]
    )
  ]);

  const identifiers = new Map<string, IdentifierRow[]>();
  for (const row of identifierResult.rows) {
    identifiers.set(row.edition_uri, [...(identifiers.get(row.edition_uri) ?? []), row]);
  }
  const contributors = new Map<string, ContributorRow[]>();
  for (const row of contributorResult.rows) {
    contributors.set(row.edition_uri, [...(contributors.get(row.edition_uri) ?? []), row]);
  }
  const publishers = new Map<string, PublisherRow>();
  for (const row of publisherResult.rows) {
    if (!publishers.has(row.edition_uri)) publishers.set(row.edition_uri, row);
  }

  return rows.map((row) =>
    editionView(row, identifiers.get(row.uri) ?? [], contributors.get(row.uri) ?? [], publishers.get(row.uri))
  );
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
  const items = await hydrate(rows);

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(counted ? { total: counted.rows[0]?.n ?? 0 } : {})
  };
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
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
      OR coalesce(e.description, '') ILIKE ${pattern}
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
     ${where}
     ORDER BY ${rankCase}, e.indexed_at DESC, e.uri ASC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const totalPromise =
    input.offset === 0
      ? pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM editions e ${where}`,
          params.slice(0, params.length - 2)
        )
      : null;

  const [page, counted] = await Promise.all([pagePromise, totalPromise]);
  const rows = page.rows.slice(0, input.limit);
  const items = await hydrate(rows);

  return {
    items,
    hasMore: page.rows.length > input.limit,
    ...(counted ? { total: counted.rows[0]?.n ?? 0 } : {})
  };
}
