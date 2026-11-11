import type { Identifier } from './editions';

/** Issuers that carry an ISBN in `searchEditions` identifiers (case-insensitive). */
const ISBN_ISSUERS: Record<string, true> = { isbn: true, isbn10: true, isbn13: true };

const ISBN13 = /^\d{13}$/;
const ISBN10 = /^\d{9}[\dX]$/;

function isbn13Checksum(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

function isbn10Checksum(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(digits[index]) * (10 - index);
  sum += digits[9] === 'X' ? 10 : Number(digits[9]);
  return sum % 11 === 0;
}

/**
 * Normalize an ISBN-10 or ISBN-13 to a checksum-valid ISBN-13. Anything else
 * (short, non-numeric, bad checksum) is not an ISBN worth hydrating and
 * returns null; callers ignore it rather than failing the request.
 */
export function toIsbn13(value: string): string | null {
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (ISBN13.test(compact)) return isbn13Checksum(compact) ? compact : null;
  if (!ISBN10.test(compact) || !isbn10Checksum(compact)) return null;

  const base = `978${compact.slice(0, 9)}`;
  let check = 0;
  for (let index = 0; index < 12; index += 1) {
    check += Number(base[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return `${base}${(10 - (check % 10)) % 10}`;
}

/** Distinct normalized ISBN-13s among the supplied identifiers. */
export function isbn13sFromIdentifiers(identifiers: Identifier[]): string[] {
  const found = new Set<string>();
  for (const identifier of identifiers) {
    if (ISBN_ISSUERS[identifier.issuer.trim().toLowerCase()] !== true) continue;
    const isbn = toIsbn13(identifier.value);
    if (isbn !== null) found.add(isbn);
  }
  return [...found];
}
