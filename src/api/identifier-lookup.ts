import { eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { normalizeIsbn } from './search-fallback.js';

const { books } = schema;

export type IdentInput =
  | { kind: 'at-uri'; uri: string }
  | { kind: 'isbn'; value: string }
  | { kind: 'identifier'; type: string; value: string };

export type ResolvedBook = typeof schema.books.$inferSelect;

export function parseIdentifierInput(raw: string): IdentInput | null {
  const input = raw?.trim();
  if (!input) return null;

  if (input.startsWith('at://')) {
    return { kind: 'at-uri', uri: input };
  }

  const urnIsbn = input.match(/^urn:isbn:(.+)$/i);
  if (urnIsbn) {
    const normalized = normalizeIsbn(urnIsbn[1]);
    if (!normalized) return null;
    if (normalized.length !== 10 && normalized.length !== 13) return null;
    return { kind: 'isbn', value: normalized };
  }

  if (/^[0-9X\- ]+$/i.test(input)) {
    const normalized = normalizeIsbn(input);
    if (normalized && (normalized.length === 10 || normalized.length === 13)) {
      return { kind: 'isbn', value: normalized };
    }
  }

  const olUrlMatch = input.match(
    /^https?:\/\/(?:www\.)?openlibrary\.org\/(works|books)\/(OL\d+[A-Z])\/?$/i,
  );
  if (olUrlMatch) {
    return {
      kind: 'identifier',
      type: 'openlibrary',
      value: `/${olUrlMatch[1].toLowerCase()}/${olUrlMatch[2].toUpperCase()}`,
    };
  }

  const gbBooksUrl = input.match(
    /^https?:\/\/books\.google\.com\/books\?(?:[^&#]*&)*id=([^&]+)/i,
  );
  if (gbBooksUrl) {
    return { kind: 'identifier', type: 'googleBooks', value: gbBooksUrl[1] };
  }
  const gbEditionUrl = input.match(
    /^https?:\/\/www\.google\.com\/books\/edition\/[^/]+\/([^?]+)/i,
  );
  if (gbEditionUrl) {
    return { kind: 'identifier', type: 'googleBooks', value: gbEditionUrl[1] };
  }

  const olidUrn = input.match(/^urn:(?:olid|openlibrary):(.+)$/i);
  if (olidUrn) {
    const inner = olidUrn[1].replace(/^\/+/, '');
    const bareOlidInUrn = inner.match(/^(OL\d+[A-Z])$/i);
    if (bareOlidInUrn) {
      const upper = bareOlidInUrn[1].toUpperCase();
      const suffix = upper.slice(-1);
      const bucket = suffix === 'W' ? 'works' : 'books';
      return { kind: 'identifier', type: 'openlibrary', value: `/${bucket}/${upper}` };
    }
    const m = inner.match(/^(works|books)\/(OL\d+[A-Z])$/i);
    if (m) {
      return {
        kind: 'identifier',
        type: 'openlibrary',
        value: `/${m[1].toLowerCase()}/${m[2].toUpperCase()}`,
      };
    }
    return null;
  }

  const grUrn = input.match(/^urn:goodreads:(\d+)$/i);
  if (grUrn) return { kind: 'identifier', type: 'goodreads', value: grUrn[1] };

  const doiUrn = input.match(/^urn:doi:(.+)$/i);
  if (doiUrn) return { kind: 'identifier', type: 'doi', value: doiUrn[1] };

  for (const t of ['asin', 'ean', 'issn', 'oclc', 'lccn']) {
    const m = input.match(new RegExp(`^urn:${t}:(.+)$`, 'i'));
    if (m) return { kind: 'identifier', type: t, value: m[1] };
  }

  const olidPath = input.match(/^\/?(works|books)\/(OL\d+[A-Z])$/i);
  if (olidPath) {
    return {
      kind: 'identifier',
      type: 'openlibrary',
      value: `/${olidPath[1].toLowerCase()}/${olidPath[2].toUpperCase()}`,
    };
  }

  const bareOlid = input.match(/^(OL\d+[A-Z])$/i);
  if (bareOlid) {
    const upper = bareOlid[1].toUpperCase();
    const suffix = upper.slice(-1);
    const bucket = suffix === 'W' ? 'works' : 'books';
    return { kind: 'identifier', type: 'openlibrary', value: `/${bucket}/${upper}` };
  }

  const bareDoi = input.match(/^(10\.\d{4,}\/\S+)$/);
  if (bareDoi) return { kind: 'identifier', type: 'doi', value: bareDoi[1] };

  return null;
}

export async function resolveBooksByIdentifier(
  db: BetterSQLite3Database<typeof schema>,
  input: string,
): Promise<ResolvedBook[]> {
  const ident = parseIdentifierInput(input);
  if (!ident) return [];

  if (ident.kind === 'at-uri') {
    const row = await db.query.books.findFirst({ where: eq(books.uri, ident.uri) });
    return row ? [row] : [];
  }

  if (ident.kind === 'isbn') {
    const row = await db.query.books.findFirst({ where: eq(books.isbn, ident.value) });
    return row ? [row] : [];
  }

  const rows = db.all(
    sql`
      SELECT b.uri
      FROM books_identifiers v
      JOIN books b ON b.uri = v.uri
      WHERE v.identifier_type = ${ident.type} AND v.identifier_value = ${ident.value}
    `,
  ) as Array<{ uri: string }>;

  if (rows.length === 0) return [];

  const uris = rows.map((r) => r.uri);
  const matches = await db.query.books.findMany({ where: inArray(books.uri, uris) });
  const byUri = new Map(matches.map((b) => [b.uri, b]));
  return uris
    .map((u) => byUri.get(u))
    .filter((b): b is ResolvedBook => Boolean(b));
}
