/**
 * Language translation between BCP-47 (the lex format on searchEditions/searchWorks)
 * and the various representations used by the upstream sources we proxy.
 *
 *  - PostgreSQL `editions.language` / `works.originalLanguage` carry mixed values:
 *    OL ingests as 3-letter MARC (`eng`), Google Books and ISBNDB as 2-letter ISO
 *    639-1 (`en`). Postgres-side filtering therefore has to expand each input tag
 *    to all known variants to avoid silent misses.
 *
 *  - OpenLibrary's `search.json?language=` accepts the MARC 3-letter form only.
 *
 *  - Google Books' `langRestrict=` accepts a single 2-letter ISO 639-1 tag and
 *    returns nothing on a multi-language request — that's why we only set it when
 *    the caller passes a single tag.
 *
 * All functions fail-closed: unparseable input returns null/empty rather than
 * a wrong-language hit, so callers can decide whether to skip the upstream param
 * or apply a defensive client-side filter.
 */

/** Loose BCP-47 structural check. We don't validate the full IANA subtag registry —
 *  the lex layer already rejects malformed tags via `format: "language"`. This
 *  just rejects obvious junk before we key a map by it. */
const BCP47_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function normalize(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  if (!BCP47_RE.test(t)) return null;
  return t;
}

/**
 * Lean BCP-47 ↔ MARC21 / ISO 639-1 map for the languages we actually index.
 * OL feeds its search index from MARC (`eng`), GB and ISBNDB from ISO 639-1 (`en`).
 * No dependency on a 200-entry library — extension tags don't change which language
 * we're matching, only which script/region variant.
 */
const ISO_639_1_TO_MARC: Record<string, string> = {
  en: 'eng',
  fr: 'fre',
  de: 'ger',
  es: 'spa',
  pt: 'por',
  it: 'ita',
  nl: 'dut',
  ja: 'jpn',
  zh: 'chi',
  ru: 'rus',
  ar: 'ara',
  ko: 'kor',
  pl: 'pol',
  sv: 'swe',
  no: 'nor',
  da: 'dan',
  fi: 'fin',
  el: 'gre',
  he: 'heb',
  tr: 'tur',
  cs: 'cze',
  hu: 'hun',
  ro: 'rum',
  uk: 'ukr',
};

const MARC_TO_ISO_639_1: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  ger: 'de',
  spa: 'es',
  por: 'pt',
  ita: 'it',
  dut: 'nl',
  jpn: 'ja',
  chi: 'zh',
  rus: 'ru',
  ara: 'ar',
  kor: 'ko',
  pol: 'pl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  heb: 'he',
  tur: 'tr',
  cze: 'cs',
  hun: 'hu',
  rum: 'ro',
  ukr: 'uk',
};

const ISO_639_2_TO_ISO_639_1: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  ger: 'de',
  spa: 'es',
  por: 'pt',
  ita: 'it',
  dut: 'nl',
  jpn: 'ja',
  chi: 'zh',
  rus: 'ru',
  ara: 'ar',
  kor: 'ko',
  pol: 'pl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  heb: 'he',
  tur: 'tr',
  cze: 'cs',
  hun: 'hu',
  rum: 'ro',
  ukr: 'uk',
};

/** Translate a BCP-47 tag to the MARC21 3-letter form OpenLibrary's `language=`
 *  parameter expects. Returns null for tags without a known mapping so the caller
 *  can choose to omit the upstream param rather than send a wrong value. */
export function toOlLanguage(tag: string): string | null {
  const norm = normalize(tag);
  if (!norm) return null;
  const base = norm.split('-')[0]!;
  if (base.length === 3 && ISO_639_2_TO_ISO_639_1[base]) {
    // already MARC (or other ISO 639-2 bibliographic) — pass through
    return base;
  }
  if (base.length === 2) {
    return ISO_639_1_TO_MARC[base] ?? null;
  }
  return null;
}

/** Translate a BCP-47 tag to the ISO 639-1 form Google Books' `langRestrict=`
 *  parameter expects. Returns null for tags without a known 2-letter base, so the
 *  caller can omit `langRestrict` rather than send a code GB will silently ignore. */
export function toGbLangRestrict(tag: string): string | null {
  const norm = normalize(tag);
  if (!norm) return null;
  const base = norm.split('-')[0]!;
  if (base.length === 2) {
    return ISO_639_1_TO_MARC[base] ? base : null;
  }
  if (base.length === 3) return MARC_TO_ISO_639_1[base] ?? null;
  return null;
}

/**
 * Expand an array of BCP-47 input tags to every Postgres-visible form we expect to
 * find in the `editions.language` / `works.originalLanguage` columns:
 *   - the normalized input itself (`en-us` matches the input tag)
 *   - the 2-letter ISO 639-1 base (`en`)
 *   - the 3-letter MARC form (`eng`)
 *
 * Both the input and the base are emitted so an `en-us` filter still hits the
 * `eng` rows OL wrote. Empty array / all-unparseable → empty array.
 */
export function pgLanguageVariants(tags: readonly string[]): string[] {
  if (tags.length === 0) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    const norm = normalize(tag);
    if (!norm) continue;
    out.add(norm);
    const base = norm.split('-')[0]!;
    out.add(base);
    const marBase = base.length === 2 ? ISO_639_1_TO_MARC[base] : undefined;
    if (marrBase(marBase)) out.add(marrBase(marBase)!);
    const iso2From3 = base.length === 3 ? MARC_TO_ISO_639_1[base] : undefined;
    if (iso2From3) out.add(iso2From3);
  }
  return Array.from(out);
}

function marrBase(v: string | undefined): string | undefined {
  return v;
}

/** Lowercase a free-form language string for comparison. Returns undefined for
 *  null/undefined so callers can spread it safely. */
export function languageOf<T extends { language?: string | null; originalLanguage?: string | null }>(
  item: T,
): string | undefined {
  const v = (item.language ?? item.originalLanguage ?? undefined) as string | null | undefined;
  if (!v) return undefined;
  return v.toLowerCase();
}

/** Returns the input tags filtered/normalized to those we can act on. Empty
 *  result means no upstream filtering is possible. */
export function translateOlLanguages(tags: readonly string[]): string[] {
  if (tags.length === 0) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    const mapped = toOlLanguage(tag);
    if (mapped) out.add(mapped);
  }
  return Array.from(out);
}
