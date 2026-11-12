import { createGate, isbn13 as normalizeIsbn13, cleanString, stripHtml } from '../util.js';
import { DEFAULT_CONTRIBUTOR_ROLE } from '../contributor-roles.js';
import { createJsonCache, fetchJson } from './http.js';

const gate = createGate(150);

function coverUrl(info) {
  const raw = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
  return typeof raw === 'string' ? raw.replace(/^http:/, 'https:') : undefined;
}

export function candidateFromVolume(item) {
  const info = item?.volumeInfo;
  if (!info || !cleanString(info.title)) return undefined;

  const identifiers = [];
  const volumeId = cleanString(item.id);
  if (volumeId) identifiers.push({ issuer: 'googlebooks', value: volumeId });
  const seen = new Set(['isbn13']);
  for (const identifier of info.industryIdentifiers ?? []) {
    const value =
      identifier.type === 'ISBN_13'
        ? normalizeIsbn13(identifier.identifier)
        : identifier.type === 'ISBN_10'
          ? normalizeIsbn13(identifier.identifier)
          : undefined;
    if (value && !seen.has(value)) {
      seen.add(value);
      identifiers.push({ issuer: 'isbn13', value });
    }
  }
  if (identifiers.length === 0) return undefined;

  const candidate = {
    identifiers,
    title: cleanString(info.title),
    contributors: [...new Set((info.authors ?? []).map(cleanString).filter(Boolean))].map((name) => ({
      name,
      role: DEFAULT_CONTRIBUTOR_ROLE
    }))
  };

  const subtitle = cleanString(info.subtitle);
  if (subtitle) candidate.subtitle = subtitle;
  const language = cleanString(info.language);
  if (language) candidate.language = language;
  const publishedDate = cleanString(info.publishedDate);
  if (publishedDate) candidate.publishedDate = publishedDate;
  const pages = Number(info.pageCount);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const description = stripHtml(info.description);
  if (description) candidate.description = description;
  const cover = coverUrl(info);
  if (cover) candidate.coverUrl = cover;
  const publisher = cleanString(info.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  return candidate;
}

export function createGoogleBooks({ pool, apiKey, baseUrl, fetchImpl = fetch }) {
  const cache = pool ? createJsonCache(pool, 'google_books_cache') : null;

  async function query(url) {
    if (cache) {
      const cached = await cache.get(url);
      if (cached !== undefined) return cached;
    }
    const body = await gate(() => fetchJson(fetchImpl, url));
    if (body !== undefined && cache) await cache.put(url, url, body);
    return body;
  }

  function candidates(body) {
    return (body?.items ?? []).map(candidateFromVolume).filter(Boolean);
  }

  return {
    async byIsbn(isbn) {
      const params = new URLSearchParams({ q: `isbn:${isbn}`, maxResults: '5', printType: 'books' });
      if (apiKey) params.set('key', apiKey);
      return candidates(await query(`${baseUrl}/volumes?${params}`));
    },

    async byVolumeId(volumeId) {
      const params = new URLSearchParams();
      if (apiKey) params.set('key', apiKey);
      const suffix = params.toString() ? `?${params}` : '';
      const body = await query(`${baseUrl}/volumes/${encodeURIComponent(volumeId)}${suffix}`);
      return [candidateFromVolume(body)].filter(Boolean);
    },

    async search({ q, title, author, identifiers }) {
      const isbn = identifiers?.find((identifier) => identifier.issuer === 'isbn13')?.value;
      const parts = [cleanString(q), cleanString(title), cleanString(author)].filter(Boolean);
      const text = parts.join(' ') || (isbn ? `isbn:${isbn}` : '');
      if (!text) return [];

      // 40 is volumes.list's maximum page size; the worker caps ingestion itself.
      const params = new URLSearchParams({ q: text, maxResults: '40', printType: 'books' });
      if (apiKey) params.set('key', apiKey);
      return candidates(await query(`${baseUrl}/volumes?${params}`));
    }
  };
}
