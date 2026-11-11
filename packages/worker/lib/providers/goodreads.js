import { createGate, cleanString, isbn13 as normalizeIsbn13, stripHtml } from '../util.js';
import { fetchText } from './http.js';

const gate = createGate(1000);
const USER_AGENT =
  'Mozilla/5.0 (compatible; Bibliograph/0.1; +https://biblio.livtet.olamaelcu.net)';

const ROLE_MAP = {
  author: 'author',
  'co-author': 'co-author',
  editor: 'editor',
  translator: 'translator',
  narrator: 'narrator',
  illustrator: 'illustrator',
  photographer: 'photographer',
  foreword: 'foreword',
  preface: 'preface',
  penciller: 'penciller',
  inker: 'inker',
  colorist: 'colorist',
  letterer: 'letterer'
};

function role(value) {
  if (typeof value !== 'string') return 'author';
  const token = value.trim().toLowerCase().replace(/\s+/g, '-');
  return ROLE_MAP[token] ?? token;
}

function nextData(html) {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function candidatesFromBookPage(html) {
  const data = nextData(html);
  const apollo = data?.props?.pageProps?.apolloState;
  if (!apollo) return [];

  const books = Object.values(apollo).filter(
    (value) => value?.__typename === 'Book' && cleanString(value.title)
  );
  const book = books.find((value) => value.details?.isbn13) ?? books[0];
  if (!book) return [];

  const identifiers = [];
  const legacyId = Number(book.legacyId);
  if (Number.isInteger(legacyId) && legacyId > 0) {
    identifiers.push({ issuer: 'goodreads', value: String(legacyId) });
  }
  const details = book.details ?? {};
  const isbn = normalizeIsbn13(details.isbn13 ?? details.isbn ?? '');
  if (isbn) identifiers.push({ issuer: 'isbn13', value: isbn });
  const asin = cleanString(details.asin);
  if (asin) identifiers.push({ issuer: 'asin', value: asin });
  if (identifiers.length === 0) return [];

  const candidate = {
    identifiers,
    title: cleanString(book.titleComplete) ?? cleanString(book.title),
    contributors: []
  };

  const contributorEdges = [book.primaryContributorEdge, ...(book.secondaryContributorEdges ?? [])];
  for (const edge of contributorEdges) {
    const contributor = edge?.node?.__ref ? apollo[edge.node.__ref] : undefined;
    const name = cleanString(contributor?.name);
    if (name) candidate.contributors.push({ name, role: role(edge.role) });
  }

  const description = stripHtml(book.description);
  if (description) candidate.description = description;
  const cover = cleanString(book.imageUrl);
  if (cover) candidate.coverUrl = cover;
  const pages = Number(details.numPages);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const format = cleanString(details.format);
  if (format) candidate.format = format;
  const language = cleanString(details.language?.name);
  if (language) candidate.language = language;
  if (Number.isFinite(details.publicationTime)) {
    candidate.publishedDate = new Date(details.publicationTime).toISOString().slice(0, 10);
  }
  const publisher = cleanString(details.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  const seriesEntry = book.bookSeries?.[0];
  const series = seriesEntry?.series?.__ref ? apollo[seriesEntry.series.__ref] : undefined;
  if (cleanString(series?.title)) {
    candidate.series = { name: series.title };
    if (cleanString(seriesEntry.userPosition)) candidate.series.position = seriesEntry.userPosition;
  }

  return [candidate];
}

export function candidatesFromSearchPage(html) {
  const rows = html.split(/<tr\s+itemscope/).slice(1);
  const candidates = [];

  for (const row of rows) {
    const id = /\/book\/show\/(\d+)/.exec(row)?.[1];
    const title = /class="bookTitle"[\s\S]*?<span[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/.exec(
      row
    )?.[1];
    if (!id || !title) continue;

    const identifiers = [{ issuer: 'goodreads', value: id }];
    const candidate = {
      identifiers,
      title: stripHtml(title),
      contributors: []
    };

    const author = /class="authorName"[\s\S]*?<span[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/.exec(
      row
    )?.[1];
    const authorName = stripHtml(author);
    if (authorName) candidate.contributors.push({ name: authorName, role: 'author' });

    const cover = /class="bookCover"[^>]*src="([^"]+)"/.exec(row)?.[1];
    if (cover) candidate.coverUrl = cover.replace(/^http:/, 'https:');

    if (candidate.title) candidates.push(candidate);
  }

  return candidates;
}

export function createGoodreads({ baseUrl, fetchImpl = fetch }) {
  const headers = { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' };

  async function get(path) {
    try {
      return await gate(() => fetchText(fetchImpl, `${baseUrl}${path}`, { headers }));
    } catch (error) {
      // Blocked or consent-walled pages are not retryable; transient statuses are.
      if (error.status === 401 || error.status === 403) return undefined;
      throw error;
    }
  }

  return {
    async byId(id) {
      const page = await get(`/book/show/${encodeURIComponent(id)}`);
      return page ? candidatesFromBookPage(page.text) : [];
    },

    async byIdentifier(value) {
      const page = await get(`/search?q=${encodeURIComponent(value)}`);
      if (!page) return [];
      return /\/book\/show\//.test(new URL(page.url).pathname)
        ? candidatesFromBookPage(page.text)
        : candidatesFromSearchPage(page.text);
    },

    async search(text) {
      const page = await get(`/search?q=${encodeURIComponent(text)}`);
      if (!page) return [];
      return [candidatesFromBookPage(page.text), candidatesFromSearchPage(page.text)].flat();
    }
  };
}
