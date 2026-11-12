/**
 * OpenLibrary provider: public bibliographic API, no key.
 *
 * Editions come from `/search.json`, `/isbn/<isbn>.json` and `/books/<key>.json`;
 * a work key expands through `/works/<key>/editions.json`. Author search uses
 * `/search/authors.json` and author detail `/authors/<key>.json`.
 *
 * The public API asks clients to be polite, so every request goes through one
 * serializing gate and carries a descriptive User-Agent. Timeouts, retries and
 * the `openlibrary` circuit breaker are supplied by `createProviderHttp`, which
 * wraps the fetch implementation this module receives.
 */

import { createGate, cleanString, isbn13 as normalizeIsbn13, mergeCandidates, stripHtml } from '../util.js';
import { DEFAULT_CONTRIBUTOR_ROLE } from '../contributor-roles.js';
import { isoCalendarDate } from '../record-fields.js';
import { fetchJson } from './http.js';

// OpenLibrary rate-limits anonymous clients to roughly one request per second.
const gate = createGate(1000);
const USER_AGENT =
  'Bibliograph/0.2 (+https://biblio.livtet.olamaelcu.net; OpenLibrary provider)';
const COVERS_BASE_URL = 'https://covers.openlibrary.org';
const MAX_AUTHOR_EXPANSIONS = 10;
const MAX_ISBN_IDENTIFIERS = 10;

/** `/search.json` page size; the worker caps ingestion at 50 candidates. */
export const SEARCH_LIMIT = 40;
export const CONTRIBUTOR_SEARCH_LIMIT_DEFAULT = 20;
export const CONTRIBUTOR_SEARCH_LIMIT_MAX = 50;

const SEARCH_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'author_key',
  'first_publish_year',
  'isbn',
  'edition_key',
  'language',
  'cover_i',
  'publisher',
  'number_of_pages_median'
].join(',');

/** External author identifiers we trust as issuers, keyed by `remote_ids` field. */
const REMOTE_ID_ISSUERS = Object.freeze({
  wikidata: 'wikidata',
  viaf: 'viaf',
  isni: 'isni',
  goodreads: 'goodreads',
  librarything: 'librarything',
  storygraph: 'storygraph',
  idref: 'idref',
  bnf: 'bnf',
  dnb: 'dnb',
  musicbrainz: 'musicbrainz',
  amazon: 'amazon'
});

const MONTHS = Object.freeze({
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
});

/**
 * A bare OpenLibrary key (`OL123M`) from a key, path or URL, or undefined.
 * OpenLibrary returns `/books/OL123M`, `OL123M` and full URLs depending on the
 * endpoint, so one normalizer covers them all.
 */
export function openLibraryKey(value) {
  const text = cleanString(value);
  if (!text) return undefined;
  const last = text.split('/').filter(Boolean).pop();
  return last && /^OL\d+[A-Z]$/.test(last) ? last : undefined;
}

/** An edition (`...M`) or work (`...W`) key, or undefined for author and junk keys. */
export function openLibraryBookKey(value) {
  const key = openLibraryKey(value);
  return key && /^OL\d+[MW]$/.test(key) ? key : undefined;
}

function normalizeLanguage(value) {
  if (typeof value === 'object' && value !== null) {
    return cleanString(value.key)?.split('/').filter(Boolean).pop();
  }
  const text = cleanString(value);
  return text?.split('/').filter(Boolean).pop();
}

function firstString(value) {
  if (Array.isArray(value)) return cleanString(value[0]);
  return cleanString(value);
}

/**
 * A full, unambiguous OpenLibrary date as `YYYY-MM-DD`.
 *
 * OpenLibrary stores dates as free text: `1965`, `July 1965`, `31 July 1965`,
 * `1965-07-31`. Only values that name a complete calendar day in an
 * unambiguous order are accepted. A year or month alone is a partial date; the
 * contributor lexicon requires a full one, so it is omitted rather than
 * guessed (there is no way to know whether `07/08/1965` is July or August).
 */
export function parseOpenLibraryDate(value) {
  const text = cleanString(value);
  if (!text) return undefined;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const normalized = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    return isoCalendarDate(normalized);
  }

  const monthFirst = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (!month) return undefined;
    return isoCalendarDate(
      `${monthFirst[3]}-${String(month).padStart(2, '0')}-${monthFirst[2].padStart(2, '0')}`
    );
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(text);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (!month) return undefined;
    return isoCalendarDate(
      `${dayFirst[3]}-${String(month).padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`
    );
  }

  return undefined;
}

/** Descriptions arrive as a string or `{ type, value }`; both become plain text. */
function textValue(value) {
  if (typeof value === 'string') return stripHtml(value);
  if (value && typeof value === 'object' && typeof value.value === 'string') {
    return stripHtml(value.value);
  }
  return undefined;
}

function coverUrl(id) {
  const value = Number(id);
  return Number.isInteger(value) && value > 0
    ? `${COVERS_BASE_URL}/b/id/${value}-L.jpg`
    : undefined;
}

function authorImageUrl(photos) {
  if (!Array.isArray(photos)) return undefined;
  for (const photo of photos) {
    const value = Number(photo);
    if (Number.isInteger(value) && value > 0) {
      return `${COVERS_BASE_URL}/a/id/${value}-L.jpg`;
    }
  }
  return undefined;
}

/**
 * ISBN identifiers from any OpenLibrary field (`isbn`, `isbn_13`, `isbn_10`).
 * Only checksum-valid values are kept; a 10-digit ISBN contributes both its
 * 13-digit form (the catalog's primary ISBN identity) and itself.
 */
function isbnIdentifiers(values) {
  const identifiers = [];
  const seen = new Set();
  const push = (issuer, value) => {
    if (identifiers.length >= MAX_ISBN_IDENTIFIERS) return;
    const key = `${issuer}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    identifiers.push({ issuer, value });
  };

  for (const raw of Array.isArray(values) ? values : []) {
    const text = cleanString(raw);
    if (!text) continue;
    const digits = text.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!/^(?:\d{13}|\d{9}[\dX])$/.test(digits)) continue;
    const isbn13 = normalizeIsbn13(digits);
    if (!isbn13) continue;
    push('isbn13', isbn13);
    if (digits.length === 10) push('isbn10', digits);
  }
  return identifiers;
}

function contributorFromEdge(edge, authorNames) {
  const key = openLibraryKey(edge?.key ?? edge?.author?.key);
  const name = cleanString(edge?.name) ?? (key ? cleanString(authorNames.get(key)) : undefined);
  if (!name) return undefined;
  const contributor = { name, role: DEFAULT_CONTRIBUTOR_ROLE };
  if (key) contributor.identifiers = [{ issuer: 'openlibrary', value: key }];
  return contributor;
}

function contributorsFromEdition(edition, authorNames) {
  const contributors = [];
  const seen = new Set();
  for (const edge of Array.isArray(edition?.authors) ? edition.authors : []) {
    const contributor = contributorFromEdge(edge, authorNames);
    if (!contributor) continue;
    const key = contributor.identifiers?.[0]?.value ?? `name:${contributor.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contributors.push(contributor);
  }
  return contributors;
}

function contributorsFromSearch(doc) {
  const names = Array.isArray(doc?.author_name) ? doc.author_name : [];
  const keys = Array.isArray(doc?.author_key) ? doc.author_key : [];
  const contributors = [];
  const seen = new Set();

  names.forEach((rawName, index) => {
    const name = cleanString(rawName);
    if (!name) return;
    const key = openLibraryKey(keys[index]);
    const dedupe = key ?? `name:${name}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const contributor = { name, role: DEFAULT_CONTRIBUTOR_ROLE };
    if (key) contributor.identifiers = [{ issuer: 'openlibrary', value: key }];
    contributors.push(contributor);
  });

  return contributors;
}

/** Normalize one `/search.json` document into the edition candidate shape. */
export function candidateFromSearchDocument(doc) {
  if (!doc || typeof doc !== 'object') return undefined;
  const title = cleanString(doc.title);
  if (!title) return undefined;

  const identifiers = [];
  const editionKeys = Array.isArray(doc.edition_key) ? doc.edition_key : [];
  let editionKey;
  for (const raw of editionKeys) {
    const key = openLibraryBookKey(raw);
    if (key && key.endsWith('M')) {
      editionKey = key;
      break;
    }
  }
  const workKey = openLibraryBookKey(doc.key);
  // A search document is work-shaped, so an edition key is preferred. The work
  // key is only used when no edition is listed; including both would make two
  // editions of one work share an identifier and collapse in `ingest`.
  const bookKey = editionKey ?? (workKey?.endsWith('W') ? workKey : undefined);
  if (bookKey) identifiers.push({ issuer: 'openlibrary', value: bookKey });
  identifiers.push(...isbnIdentifiers(doc.isbn));
  if (identifiers.length === 0) return undefined;

  const candidate = { identifiers, title, contributors: contributorsFromSearch(doc) };

  const subtitle = cleanString(doc.subtitle);
  if (subtitle) candidate.subtitle = subtitle;
  const language = normalizeLanguage(firstString(doc.language));
  if (language) candidate.language = language;
  const publishedYear = Number(doc.first_publish_year ?? doc.publish_year?.[0]);
  if (Number.isInteger(publishedYear) && publishedYear > 0) {
    candidate.publishedDate = String(publishedYear);
  }
  const pages = Number(doc.number_of_pages_median);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const cover = coverUrl(doc.cover_i);
  if (cover) candidate.coverUrl = cover;
  const publisher = firstString(doc.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  return candidate;
}

/**
 * Normalize one edition/books document. `authorNames` maps author keys to the
 * names fetched from `/authors/<key>.json`; `workDescription` fills a missing
 * edition description from the work record.
 */
export function candidateFromEdition(edition, { authorNames = new Map(), workDescription } = {}) {
  if (!edition || typeof edition !== 'object') return undefined;
  const title = cleanString(edition.title);
  if (!title) return undefined;

  const identifiers = [];
  const key = openLibraryBookKey(edition.key);
  if (key) identifiers.push({ issuer: 'openlibrary', value: key });
  identifiers.push(
    ...isbnIdentifiers([...(edition.isbn_13 ?? []), ...(edition.isbn_10 ?? []), ...(edition.isbn ?? [])])
  );
  if (identifiers.length === 0) return undefined;

  const candidate = {
    identifiers,
    title,
    contributors: contributorsFromEdition(edition, authorNames)
  };

  const subtitle = cleanString(edition.subtitle);
  if (subtitle) candidate.subtitle = subtitle;
  const language = normalizeLanguage(edition.languages?.[0] ?? edition.language);
  if (language) candidate.language = language;
  const publishedDate = cleanString(edition.publish_date);
  if (publishedDate) candidate.publishedDate = publishedDate;
  const format = cleanString(edition.physical_format);
  if (format) candidate.format = format;
  const pages = Number(edition.number_of_pages);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const description = textValue(edition.description) ?? workDescription;
  if (description) candidate.description = description;
  const cover = coverUrl(edition.covers?.[0]);
  if (cover) candidate.coverUrl = cover;
  const publisher = firstString(edition.publishers);
  if (publisher) candidate.publisher = { name: publisher };
  const series = firstString(edition.series);
  if (series) candidate.series = { name: series };

  return candidate;
}

/**
 * Normalize an author search doc or author detail record into a contributor
 * candidate. The candidate is descriptive only: no roles, because roles belong
 * to edition credits.
 */
export function contributorFromAuthorDocument(doc) {
  if (!doc || typeof doc !== 'object') return undefined;
  const displayName = cleanString(doc.name) ?? cleanString(doc.personal_name);
  if (!displayName) return undefined;

  const key = openLibraryKey(doc.key);
  const identifiers = [];
  const seen = new Set();
  const push = (issuer, value) => {
    const id = cleanString(value);
    if (!id) return;
    const dedupe = `${issuer}\u0000${id}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    identifiers.push({ issuer, value: id });
  };

  if (key && key.endsWith('A')) push('openlibrary', key);
  const remote = doc.remote_ids && typeof doc.remote_ids === 'object' ? doc.remote_ids : {};
  for (const [field, issuer] of Object.entries(REMOTE_ID_ISSUERS)) {
    push(issuer, remote[field]);
  }

  const contributor = { displayName, identifiers };
  if (key && key.endsWith('A')) contributor.key = key;
  const description = textValue(doc.bio);
  if (description) contributor.description = description;
  const imageUrl = authorImageUrl(doc.photos);
  if (imageUrl) contributor.imageUrl = imageUrl;
  const born = parseOpenLibraryDate(doc.birth_date);
  if (born) contributor.born = born;
  const died = parseOpenLibraryDate(doc.death_date);
  if (died) contributor.died = died;

  return contributor;
}

export function createOpenLibrary({ baseUrl, fetchImpl = fetch } = {}) {
  if (!cleanString(baseUrl)) {
    throw new Error('createOpenLibrary requires a base URL');
  }
  const root = baseUrl.replace(/\/+$/, '');
  const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };

  async function query(path) {
    return gate(() => fetchJson(fetchImpl, `${root}${path}`, { headers }));
  }

  async function expandEdition(edition, { expandWork = true, authorNames = new Map(), budget } = {}) {
    if (!edition) return undefined;

    const workKey = openLibraryBookKey(edition.works?.[0]?.key);
    let workDescription;
    if (expandWork && workKey && !textValue(edition.description)) {
      try {
        const work = await query(`/works/${workKey}.json`);
        workDescription = textValue(work?.description);
      } catch {
        // The edition itself is usable; a failed enrichment fetch is not fatal.
      }
    }

    for (const edge of Array.isArray(edition.authors) ? edition.authors : []) {
      const key = openLibraryKey(edge?.key ?? edge?.author?.key);
      if (!key || cleanString(edge?.name) || authorNames.has(key)) continue;
      if (budget && budget.remaining <= 0) continue;
      if (budget) budget.remaining -= 1;
      try {
        const author = await query(`/authors/${key}.json`);
        const name = cleanString(author?.name) ?? cleanString(author?.personal_name);
        if (name) authorNames.set(key, name);
      } catch {
        // An unnamed author is omitted rather than guessed; the edition stands.
      }
    }

    return candidateFromEdition(edition, { authorNames, workDescription });
  }

  async function byIsbn(isbn) {
    const normalized = normalizeIsbn13(isbn);
    if (!normalized) return [];
    const edition = await query(`/isbn/${encodeURIComponent(normalized)}.json`);
    return [await expandEdition(edition)].filter(Boolean);
  }

  async function byIdentifier(value) {
    const key = openLibraryBookKey(value);
    if (!key) return [];

    if (key.endsWith('M')) {
      const edition = await query(`/books/${key}.json`);
      return [await expandEdition(edition)].filter(Boolean);
    }

    const body = await query(`/works/${key}/editions.json?limit=${SEARCH_LIMIT}`);
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    const authorNames = new Map();
    const budget = { remaining: MAX_AUTHOR_EXPANSIONS };
    const candidates = [];
    for (const entry of entries.slice(0, SEARCH_LIMIT)) {
      // The editions endpoint is already work-scoped; only author names need
      // expansion. The shared budget keeps one work lookup from fanning out.
      const candidate = await expandEdition(entry, {
        expandWork: false,
        authorNames,
        budget
      });
      if (candidate) candidates.push(candidate);
    }
    return mergeCandidates(candidates);
  }

  async function search(input = {}) {
    const isbn = input.identifiers?.find((identifier) =>
      ['isbn13', 'isbn10', 'isbn'].includes(identifier?.issuer)
    )?.value;
    if (isbn) {
      const candidates = await byIsbn(isbn);
      if (candidates.length > 0) return candidates;
    }

    const text =
      [cleanString(input.q), cleanString(input.title), cleanString(input.author)]
        .filter(Boolean)
        .join(' ') || (isbn ? normalizeIsbn13(isbn) : undefined);
    if (!text) return [];

    const params = new URLSearchParams({
      q: text,
      limit: String(SEARCH_LIMIT),
      fields: SEARCH_FIELDS
    });
    const body = await query(`/search.json?${params}`);
    return mergeCandidates(
      (body?.docs ?? []).map(candidateFromSearchDocument).filter(Boolean)
    );
  }

  async function searchContributors(q, { limit } = {}) {
    const text = cleanString(q);
    if (!text) return [];
    const requested = Number(limit);
    const capped = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), CONTRIBUTOR_SEARCH_LIMIT_MAX)
      : CONTRIBUTOR_SEARCH_LIMIT_DEFAULT;

    const params = new URLSearchParams({ q: text, limit: String(capped) });
    const body = await query(`/search/authors.json?${params}`);
    return (body?.docs ?? []).map(contributorFromAuthorDocument).filter(Boolean);
  }

  /** Full author record for a contributor candidate; undefined on 404. */
  async function author(value) {
    const key = openLibraryKey(value);
    if (!key || !key.endsWith('A')) return undefined;
    const body = await query(`/authors/${key}.json`);
    return body ? contributorFromAuthorDocument(body) : undefined;
  }

  return {
    byIsbn,
    byIdentifier,
    search,
    searchContributors,
    author,
    byAuthorKey: author
  };
}
