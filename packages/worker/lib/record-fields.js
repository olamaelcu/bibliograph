/**
 * Field helpers shared by the edition and entity record builders.
 *
 * The builders are the only place catalog rows become lexicon values, so the
 * shape rules live here once: non-empty strings, identifier pairs, http(s)
 * URLs, timestamps, and the strict full ISO-8601 calendar date the contributor
 * and publisher lexicons require.
 *
 * Lexicon strings cannot carry a regular expression (the specification defines
 * no `pattern` field), so a `YYYY-MM-DD` date is enforced here at write time —
 * pattern and real calendar — and documented in the lexicon description.
 */

export function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** One `defs#identifier` value, or undefined when either half is empty. */
export function identifier(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const issuer = nonEmptyString(value.issuer);
  const id = nonEmptyString(value.value);
  if (!issuer || !id) return undefined;
  return {
    issuer,
    value: id,
    ...(nonEmptyString(value.url) ? { url: value.url } : {})
  };
}

/** Stored identifiers are jsonb; tolerate both parsed arrays and JSON text. */
export function identifierArray(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map(identifier).filter(Boolean);
}

/**
 * Deduplicate identifier pairs by `issuer` + `value`, keeping the first `url`,
 * and sort so the array is canonical: the same set always serializes the same
 * way, which is what makes `(lower(name), identifiers)` a set key rather than a
 * byte-order coincidence.
 */
export function canonicalIdentifiers(value) {
  const seen = new Set();
  const bag = [];
  for (const entry of identifierArray(value)) {
    const key = `${entry.issuer}\u0000${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bag.push(entry);
  }
  bag.sort((left, right) =>
    left.issuer === right.issuer
      ? left.value.localeCompare(right.value)
      : left.issuer.localeCompare(right.issuer)
  );
  return bag;
}

export function httpUrl(value) {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A full `YYYY-MM-DD` calendar date, or undefined.
 *
 * Rejects a partial date (`1984`, `1984-06`), a non-zero-padded one
 * (`1984-6-1`), and a syntactically valid but impossible one (`2023-02-29`,
 * `1984-13-01`, `1984-00-10`). `setUTCFullYear` is used so years below 100 are
 * not remapped into the 1900s by `Date.UTC`.
 */
export function isoCalendarDate(value) {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const match = ISO_DATE.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return text;
}

/** ISO timestamp for a catalog `created_at`, or undefined when unusable. */
export function createdAtIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}
