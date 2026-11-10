import { normalizeBookFormat, type BookFormat } from "../format-view";
import { request } from "../http/client";

/**
 * Last-resort format/page-count lookup through Goodreads.
 *
 * The structured providers are preferred: Google Books and ISBNDb expose the
 * binding and page count as data, and Google Books exposes the page count. A
 * Google-only edition carries no format at all, though, and Goodreads's book
 * page publishes both in one labelled paragraph:
 *
 *   <p data-testid="pagesFormat">196 pages, Hardcover</p>
 *
 * This is deliberately kept out of request handlers. Goodreads is HTML, not an
 * API, and a backfill script is the only caller so a template change or a
 * rate-limit response can never break a reader's page.
 */

const SEARCH_URL = "https://www.goodreads.com/search";
const BOOK_URL = "https://www.goodreads.com/book/show";
/** Goodreads answered with an anti-bot / rate-limit status, not a missing book. */
export class GoodreadsBlockedError extends Error {
  constructor(readonly status: number) {
    super(`goodreads blocked the request with HTTP ${status}`);
    this.name = "GoodreadsBlockedError";
  }
}

/** Only a backfill script calls this (see above), so it keeps a looser budget than the 3s request default. */
const FETCH_TIMEOUT_MS = 10_000;

export interface GoodreadsFormat {
  url: string;
  pages?: number;
  format?: BookFormat;
}

export interface GoodreadsGenre {
  name: string;
  url: string;
}

export interface GoodreadsContributor {
  name: string;
  role: string;
  url: string;
  imageUrl?: string;
}

export interface GoodreadsBook extends GoodreadsFormat {
  title?: string;
  imageUrl?: string;
  isbn10?: string;
  isbn13?: string;
  asin?: string;
  publishedYear?: number;
  /** ISO date from Goodreads's `publicationTime`, when present. */
  publishedDate?: string;
  publisher?: string;
  language?: string;
  genres: GoodreadsGenre[];
  contributors: GoodreadsContributor[];
}

export interface GoodreadsAuthor {
  url: string;
  name?: string;
  imageUrl?: string;
}

export interface GoodreadsSearchHit {
  id: string;
  title: string;
  authors: string[];
  coverImageUrl?: string;
  publishedYear?: number;
}

export interface GoodreadsSearchResult {
  hits: GoodreadsSearchHit[];
  total: number;
}

const PAGES_FORMAT_RE =
  /<p[^>]*data-testid="pagesFormat"[^>]*>([\s\S]*?)<\/p>/i;
const BOOK_ID_RE = /\/book\/show\/(\d+)/;
const GENRE_LINK_RE =
  /href="https:\/\/www\.goodreads\.com\/genres\/([^"]+)"[^>]*>([^<]*)</gi;
const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i;

/** Extract the first Goodreads book id from a search-results page. */
export function goodreadsBookIdFromSearch(html: string): string | null {
  return BOOK_ID_RE.exec(html)?.[1] ?? null;
}

/**
 * Parse the labelled `pagesFormat` paragraph. Returns `null` when the page has
 * no such element; a page with the element but no page count still reports the
 * format it found.
 */
export function parseGoodreadsFormat(
  html: string,
): { pages?: number; format?: BookFormat } | null {
  const match = PAGES_FORMAT_RE.exec(html);
  const inner = match?.[1];
  if (inner === undefined) return null;

  const text = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;

  const pagesMatch = /(\d[\d,]*)\s+pages?/i.exec(text);
  const pages = pagesMatch
    ? Number.parseInt(pagesMatch[1]!.replace(/,/g, ""), 10)
    : undefined;

  const tail = pagesMatch
    ? text.slice(pagesMatch.index + pagesMatch[0].length)
    : text;
  const formatText =
    tail
      .replace(/^[,\s]+/, "")
      .split(",")[0]
      ?.trim() ?? "";
  const format = normalizeBookFormat(formatText);

  if (pages === undefined && format === undefined) return null;
  return {
    ...(pages !== undefined && Number.isFinite(pages) && pages > 0
      ? { pages }
      : {}),
    ...(format !== undefined ? { format } : {}),
  };
}

function nextData(html: string): unknown {
  const raw = NEXT_DATA_RE.exec(html)?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function contributorFromEdge(
  state: Record<string, unknown>,
  edge: unknown,
): GoodreadsContributor | null {
  const edgeObject = objectOf(edge);
  const node = objectOf(edgeObject?.node);
  const ref = stringOf(node?.__ref);
  const contributor = (ref ? objectOf(state[ref]) : null) ?? node;
  if (!contributor) return null;
  const name = stringOf(contributor.name);
  const url = stringOf(contributor.webUrl);
  if (!name || !url) return null;
  const imageUrl = stringOf(contributor.profileImageUrl);
  return {
    name,
    role: stringOf(edgeObject?.role) ?? "Author",
    url,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

/** Extract the Apollo `Book:` object, genres, and detail fields from the page. */
function parseNextDataBook(html: string): Partial<GoodreadsBook> | null {
  const data = objectOf(nextData(html));
  const props = objectOf(data?.props);
  const pageProps = objectOf(props?.pageProps);
  const state = objectOf(pageProps?.apolloState);
  if (!state) return null;

  const key = Object.keys(state).find(
    (candidate) =>
      candidate.startsWith("Book:") &&
      objectOf(state[candidate])?.details !== undefined,
  );
  const book = key ? objectOf(state[key]) : null;
  if (!book) return null;

  const details = objectOf(book.details) ?? {};
  const rawGenres = Array.isArray(book.bookGenres) ? book.bookGenres : [];
  const genres: GoodreadsGenre[] = [];
  for (const entry of rawGenres) {
    const genre = objectOf(objectOf(entry)?.genre);
    const name = stringOf(genre?.name);
    const url = stringOf(genre?.webUrl);
    if (name && url) genres.push({ name, url });
  }

  const edges = [
    book.primaryContributorEdge,
    ...(Array.isArray(book.secondaryContributorEdges)
      ? book.secondaryContributorEdges
      : []),
  ];
  const contributors: GoodreadsContributor[] = [];
  const seenContributors = new Set<string>();
  for (const edge of edges) {
    const contributor = contributorFromEdge(state, edge);
    if (!contributor || seenContributors.has(contributor.url)) continue;
    seenContributors.add(contributor.url);
    contributors.push(contributor);
  }

  const publicationMs = numberOf(details.publicationTime);
  const publicationDate =
    publicationMs !== undefined ? new Date(publicationMs) : null;
  const validDate =
    publicationDate !== null && Number.isFinite(publicationDate.getTime())
      ? publicationDate
      : null;

  return {
    title: stringOf(book.titleComplete) ?? stringOf(book.title),
    imageUrl: stringOf(book.imageUrl),
    pages: numberOf(details.numPages),
    format: normalizeBookFormat(stringOf(details.format) ?? null),
    isbn10: stringOf(details.isbn),
    isbn13: stringOf(details.isbn13),
    asin: stringOf(details.asin),
    publishedYear: validDate?.getUTCFullYear(),
    publishedDate: validDate?.toISOString().slice(0, 10),
    publisher: stringOf(details.publisher),
    language: stringOf(objectOf(details.language)?.name),
    genres,
    contributors,
  };
}

/**
 * The full set of display facts Goodreads exposes on a book page. The HTML
 * paragraph is the fallback when the Next.js payload is absent or reshaped.
 */
function parseGenreLinks(html: string): GoodreadsGenre[] {
  const genres: GoodreadsGenre[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(GENRE_LINK_RE)) {
    const slug = match[1];
    const name = match[2]?.trim();
    if (!slug || !name || seen.has(slug)) continue;
    seen.add(slug);
    genres.push({ name, url: `https://www.goodreads.com/genres/${slug}` });
  }
  return genres;
}

export function parseGoodreadsBook(
  html: string,
  url = "",
): GoodreadsBook | null {
  const structured = parseNextDataBook(html);
  const fallback = parseGoodreadsFormat(html);
  if (!structured && !fallback) return null;
  const structuredGenres = structured?.genres;
  const genres =
    structuredGenres && structuredGenres.length > 0
      ? structuredGenres
      : parseGenreLinks(html);
  const book: GoodreadsBook = {
    url,
    genres,
    contributors: structured?.contributors ?? [],
  };
  if (structured?.title) book.title = structured.title;
  if (structured?.imageUrl) book.imageUrl = structured.imageUrl;
  const pages = structured?.pages ?? fallback?.pages;
  if (pages !== undefined) book.pages = pages;
  const format = structured?.format ?? fallback?.format;
  if (format !== undefined) book.format = format;
  if (structured?.isbn10) book.isbn10 = structured.isbn10;
  if (structured?.isbn13) book.isbn13 = structured.isbn13;
  if (structured?.asin) book.asin = structured.asin;
  if (structured?.publishedYear !== undefined) {
    book.publishedYear = structured.publishedYear;
  }
  if (structured?.publishedDate) book.publishedDate = structured.publishedDate;
  if (structured?.publisher) book.publisher = structured.publisher;
  if (structured?.language) book.language = structured.language;
  return book;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Parse the modern `book-item-*` search-results markup. */
export function parseGoodreadsSearch(html: string): GoodreadsSearchResult {
  const hits: GoodreadsSearchHit[] = [];
  const seen = new Set<string>();
  const titleRe =
    /data-testid="book-item-title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(titleRe)) {
    const id = /\/book\/show\/(\d+)/.exec(match[1] ?? "")?.[1];
    const title = textOf(match[2] ?? "");
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const start = match.index ?? 0;
    const statsAt = html.indexOf('data-testid="book-item-stats"', start);
    const actionsAt = html.indexOf("BookActions", start);
    const authorBlock = html.slice(
      start,
      statsAt > start ? statsAt : start + 8_000,
    );
    const authors: string[] = [];
    for (const author of authorBlock.matchAll(
      /class="ContributorLink__name"[^>]*>([^<]+)<\/span>/g,
    )) {
      const name = textOf(author[1] ?? "");
      if (name && !authors.includes(name)) authors.push(name);
    }

    const yearBlock = html.slice(
      statsAt > start ? statsAt : start,
      actionsAt > start ? actionsAt : start + 8_000,
    );
    const publication =
      /data-testid="book-item-publication-year"[^>]*>([\s\S]*?)<\/span>/i.exec(
        yearBlock,
      )?.[1];
    const year = publication
      ? /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(textOf(publication))?.[1]
      : undefined;

    const coverRe = new RegExp(
      `<img[^>]*src="([^"]*books/[^"]*/${id}\\.[^"]+)"`,
    );
    const cover = coverRe.exec(html)?.[1];

    hits.push({
      id,
      title,
      authors,
      ...(cover ? { coverImageUrl: decodeEntities(cover) } : {}),
      ...(year ? { publishedYear: Number(year) } : {}),
    });
  }

  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const totalMatch =
    /(?:of (?:over )?|Showing 1-\d+ of )([\d,]+)\s+results/i.exec(clean);
  const total = totalMatch
    ? Number(totalMatch[1]?.replace(/,/g, "") ?? 0)
    : hits.length;
  return { hits, total };
}

function metaContent(
  html: string,
  attribute: string,
  value: string,
): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${value}["']`, "i").test(tag)) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
    if (content) return content;
  }
  return undefined;
}

/** The author page is the classic Goodreads app; its OpenGraph tags carry the portrait. */
export function parseGoodreadsAuthor(
  html: string,
  url = "",
): GoodreadsAuthor | null {
  const imageUrl =
    metaContent(html, "property", "og:image") ??
    metaContent(html, "itemprop", "image");
  const name = metaContent(html, "property", "og:title");
  if (!imageUrl && !name) return null;
  return {
    url,
    ...(name ? { name } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function isAuthorUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname === "www.goodreads.com" &&
      parsed.pathname.startsWith("/author/show/")
    );
  } catch {
    return false;
  }
}

type CookieJar = Map<string, string>;

function applySetCookies(jar: CookieJar, headers: Headers): void {
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function fetchText(
  url: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    let current = url;
    // Goodreads answers a cookieless request with a 302 back to the same URL,
    // setting a session cookie. Undici does not retain cookies across manual
    // redirects, so the jar is what turns that bounce into the real page.
    for (let hop = 0; hop < 6; hop += 1) {
      const cookie = [...jar]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const res = await request(current, {
        signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        redirect: "manual",
        headers: {
          accept: "text/html",
          ...(cookie.length > 0 ? { cookie } : {}),
        },
      });
      applySetCookies(jar, res.headers);
      if (res.status === 202 || res.status === 403 || res.status === 429) {
        throw new GoodreadsBlockedError(res.status);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return null;
      return await res.text();
    }
    return null;
  } catch (err) {
    if (err instanceof GoodreadsBlockedError) throw err;
    return null;
  }
}

/**
 * Search Goodreads by ISBN, then read the book page's `pagesFormat` field.
 * `null` means the search had no book, the page had no field, or either request
 * failed; callers leave the edition untouched.
 */
export async function fetchGoodreadsAuthor(
  url: string,
  signal?: AbortSignal,
): Promise<GoodreadsAuthor | null> {
  if (!isAuthorUrl(url)) return null;
  const jar: CookieJar = new Map();
  const html = await fetchText(url, jar, signal);
  return html ? parseGoodreadsAuthor(html, url) : null;
}

export async function fetchGoodreadsSearch(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<GoodreadsSearchResult | null> {
  const value = query.trim();
  if (!value) return null;
  const jar: CookieJar = new Map();
  const html = await fetchText(
    `${SEARCH_URL}?q=${encodeURIComponent(value)}`,
    jar,
    signal,
  );
  if (!html) return null;
  const parsed = parseGoodreadsSearch(html);
  return { ...parsed, hits: parsed.hits.slice(0, limit) };
}

export async function fetchGoodreadsBookById(
  id: string,
  signal?: AbortSignal,
): Promise<GoodreadsBook | null> {
  if (!/^\d+$/.test(id)) return null;
  const jar: CookieJar = new Map();
  const url = `${BOOK_URL}/${id}`;
  const html = await fetchText(url, jar, signal);
  return html ? parseGoodreadsBook(html, url) : null;
}

export async function fetchGoodreadsFormat(
  isbn: string,
  signal?: AbortSignal,
): Promise<GoodreadsFormat | null> {
  const book = await fetchGoodreadsBook(isbn, signal);
  if (!book) return null;
  return { url: book.url, pages: book.pages, format: book.format };
}

export async function fetchGoodreadsBook(
  isbn: string,
  signal?: AbortSignal,
): Promise<GoodreadsBook | null> {
  const normalized = isbn.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (normalized.length !== 10 && normalized.length !== 13) return null;
  const jar: CookieJar = new Map();

  const searchHtml = await fetchText(
    `${SEARCH_URL}?q=${encodeURIComponent(normalized)}`,
    jar,
    signal,
  );
  if (!searchHtml) return null;
  const id = goodreadsBookIdFromSearch(searchHtml);
  if (!id) return null;

  const url = `${BOOK_URL}/${id}`;
  const pageHtml = await fetchText(url, jar, signal);
  if (!pageHtml) return null;
  return parseGoodreadsBook(pageHtml, url);
}
