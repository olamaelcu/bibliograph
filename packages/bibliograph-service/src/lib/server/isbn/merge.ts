import type { Identifier } from '../search/types';

/**
 * ISBN identifiers on an edition record.
 *
 * `community.lexicon.book.edition#identifier` is a flat `{ uri, resource }`
 * list, and the reading clients pick the first entry whose resource is one of
 * `isbn`/`isbn10`/`isbn13` and whose uri is `isbn:<digits>`. Everything here
 * keeps that contract: append-only, ISBN-13 first, no duplicates.
 */

/** Resources the lexicon and the clients treat as an ISBN. */
const ISBN_RESOURCES: Record<string, true> = { isbn: true, isbn10: true, isbn13: true };

/** `edition#identifier` caps the array at 32 entries. */
export const MAX_IDENTIFIERS = 32;

export function isIsbnResource(resource: string): boolean {
  return ISBN_RESOURCES[resource] === true;
}

/** Digits only, with a trailing `X` kept for ISBN-10. Hyphens and spaces go. */
export function normaliseIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** The ISBN an identifier carries, or null when it is not a usable one. */
export function isbnFromIdentifier(identifier: Identifier): string | null {
  if (!isIsbnResource(identifier.resource)) return null;
  if (!identifier.uri.startsWith('isbn:')) return null;
  const value = normaliseIsbn(identifier.uri.slice('isbn:'.length));
  return value.length === 10 || value.length === 13 ? value : null;
}

export function hasIsbn(identifiers: readonly Identifier[] | undefined): boolean {
  return (identifiers ?? []).some((ident) => isbnFromIdentifier(ident) !== null);
}

/** Build the identifier for a raw ISBN, choosing the resource from its length. */
export function isbnIdentifier(raw: string): Identifier | null {
  const value = normaliseIsbn(raw);
  if (value.length === 13) return { uri: `isbn:${value}`, resource: 'isbn13' };
  if (value.length === 10) return { uri: `isbn:${value}`, resource: 'isbn10' };
  return null;
}

/**
 * Append ISBN identifiers to an edition's identifier list.
 *
 * Nothing already present is removed or reordered: this runs against records
 * other systems may have written, so the only safe direction is additive.
 * ISBN-13 sorts ahead of ISBN-10 because the reading side takes the first hit,
 * and the result stops at the lexicon's 32-entry cap rather than producing a
 * record the lexicon would reject.
 */
export function mergeIsbnIdentifiers(
  existing: readonly Identifier[],
  candidates: readonly string[],
  max = MAX_IDENTIFIERS,
): { identifiers: Identifier[]; added: string[] } {
  const identifiers = existing.map((ident) => ({ uri: ident.uri, resource: ident.resource }));
  const seen = new Set(
    identifiers
      .map((ident) => isbnFromIdentifier(ident))
      .filter((value): value is string => value !== null),
  );

  const incoming: Identifier[] = [];
  for (const raw of candidates) {
    const value = normaliseIsbn(raw);
    const ident = isbnIdentifier(value);
    if (!ident || seen.has(value)) continue;
    seen.add(value);
    incoming.push(ident);
  }

  incoming.sort((a, b) => (a.resource === b.resource ? 0 : a.resource === 'isbn13' ? -1 : 1));
  const room = Math.max(0, max - identifiers.length);
  const added = incoming.slice(0, room);

  return {
    identifiers: [...identifiers, ...added],
    added: added.map((ident) => ident.uri.slice('isbn:'.length)),
  };
}
