import { createGate, isbn13 as normalizeIsbn13, cleanString, stripHtml } from '../util.js';
import { createJsonCache, fetchJson } from './http.js';

const gate = createGate(1000);

export function candidateFromIsbndb(book) {
  if (!book || !cleanString(book.title)) return undefined;

  const identifiers = [];
  const isbn13 = normalizeIsbn13(book.isbn13 ?? book.isbn ?? '');
  if (isbn13) identifiers.push({ issuer: 'isbn13', value: isbn13 });
  if (identifiers.length === 0) return undefined;

  const candidate = {
    identifiers,
    title: cleanString(book.title),
    contributors: [...new Set((book.authors ?? []).map(cleanString).filter(Boolean))].map((name) => ({
      name,
      role: 'author'
    }))
  };

  const subtitle = cleanString(book.title_long)?.replace(`${candidate.title}:`, '').trim();
  if (subtitle) candidate.subtitle = subtitle;
  const language = cleanString(book.language);
  if (language) candidate.language = language;
  const publishedDate = cleanString(book.date_published);
  if (publishedDate) candidate.publishedDate = publishedDate;
  const pages = Number(book.pages);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const description = stripHtml(book.synopsis);
  if (description) candidate.description = description;
  const cover = cleanString(book.image);
  if (cover) candidate.coverUrl = cover.replace(/^http:/, 'https:');
  const publisher = cleanString(book.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  return candidate;
}

export function createIsbndb({ pool, apiKey, baseUrl, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const cache = pool ? createJsonCache(pool, 'isbndb_cache') : null;
  const headers = { authorization: apiKey, accept: 'application/json' };

  async function query(url) {
    if (cache) {
      const cached = await cache.get(url);
      if (cached !== undefined) return cached;
    }
    const body = await gate(() => fetchJson(fetchImpl, url, { headers }));
    if (body !== undefined && cache) await cache.put(url, url, body);
    return body;
  }

  return {
    async byIsbn(isbn) {
      const body = await query(`${baseUrl}/book/${encodeURIComponent(isbn)}`);
      return [candidateFromIsbndb(body?.book)].filter(Boolean);
    },

    async search(text) {
      const body = await query(`${baseUrl}/books/${encodeURIComponent(text)}`);
      return (body?.books ?? []).map(candidateFromIsbndb).filter(Boolean);
    }
  };
}
