/**
 * The `identifiers` query parameter shared by the two resolvers.
 *
 * A resolver matches exact `(issuer, value)` pairs, and a query cannot carry
 * the body form's array of objects, so each pair travels as its own repeated
 * parameter: `?identifiers=isbn13:9780441478125&identifiers=isni:0000…`.
 *
 * The split is on the **first** colon only. An issuer is a bare token and can
 * never contain one, while an identifier value can (a URI or a namespaced id),
 * so `issuer:value:with:colons` stays one pair. An entry with no colon, an
 * empty issuer or an empty value is malformed and fails the whole call rather
 * than being skipped: a caller that mistyped a pair must not silently receive a
 * page that omits it.
 *
 * Duplicates collapse, matching the body form: comparison is exact, so the
 * same pair twice is one lookup.
 *
 * Free of `$env` and SvelteKit imports (like `./dispatch.ts`) so it is testable.
 */

import type { Identifier } from '../catalog/edition-view.ts';

/** `null` means at least one entry was malformed; an empty array is no entries. */
export function parseIdentifierParams(values: string[]): Identifier[] | null {
  const identifiers: Identifier[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const colon = entry.indexOf(':');
    if (colon <= 0 || colon === entry.length - 1) return null;
    const issuer = entry.slice(0, colon);
    const value = entry.slice(colon + 1);
    const key = `${issuer}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ issuer, value });
  }
  return identifiers;
}
