import type { BookData, BookProvider } from "./interface.js";
import { BaseBookProvider } from "./base-provider.js";

const BASE_URL = "https://www.goodreads.com";
const AUTO_COMPLETE_URL = `${BASE_URL}/book/auto_complete`;
const BOOK_SHOW_URL = `${BASE_URL}/book/show/`;
const NEXT_DATA_MARKER = `__NEXT_DATA__" type="application/json">`;

interface GoodreadsAutoCompleteAuthor {
  name?: string;
}

interface GoodreadsAutoCompleteDescription {
  html?: string;
}

interface GoodreadsAutoCompleteHit {
  imageUrl?: string;
  bookId?: string;
  title?: string;
  bookTitleBare?: string;
  numPages?: number | null;
  author?: GoodreadsAutoCompleteAuthor;
  description?: GoodreadsAutoCompleteDescription;
}

const IMAGE_SIZE_SUFFIX = /\._[A-Z]{2}\d+_\./g;

function stripImageSizeSuffix(url: string): string {
  return url.replace(IMAGE_SIZE_SUFFIX, ".");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class GoodreadsProvider extends BaseBookProvider implements BookProvider {
  getName(): string {
    return "Goodreads";
  }

  async searchByIsbn(isbn: string): Promise<BookData | null> {
    const params = new URLSearchParams({ format: 'json', q: isbn, limit: '20' });
    const url = `${AUTO_COMPLETE_URL}?${params.toString()}`;
    const data = await this.fetchJson<GoodreadsAutoCompleteHit[]>(url);
    if (!data || data.length === 0) return null;
    return this.mapAutoCompleteHitToBookData(data[0]);
  }

  async searchByTitle(title: string, author?: string): Promise<BookData[]> {
    const q = author ? `${title} ${author}` : title;
    const params = new URLSearchParams({ format: 'json', q, limit: '20' });
    const url = `${AUTO_COMPLETE_URL}?${params.toString()}`;
    const data = await this.fetchJson<GoodreadsAutoCompleteHit[]>(url);
    if (!data || data.length === 0) return [];

    const results: BookData[] = [];
    for (const hit of data) {
      const mapped = this.mapAutoCompleteHitToBookData(hit);
      if (mapped) results.push(mapped);
    }
    return results;
  }

  // Plain HTML fetch. Goodreads AWS WAF returns a 202 challenge to most
  // non-browser fetches today; if the body lacks __NEXT_DATA__ we treat that as
  // "couldn't get data" and return null. A future WAF solver (see bookhive
  // src/scrapers/waf/) can be slotted in here as a fallback without changing
  // the public method.
  async getBookDetails(id: string): Promise<BookData | null> {
    const html = await this.fetchText(`${BOOK_SHOW_URL}${encodeURIComponent(id)}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.goodreads.com/",
      },
    });
    if (!html) return null;

    return this.extractNextData(html);
  }

  private extractNextData(html: string): BookData | null {
    const startIdx = html.indexOf(NEXT_DATA_MARKER);
    if (startIdx === -1) return null;
    const after = html.slice(startIdx + NEXT_DATA_MARKER.length);
    const endIdx = after.indexOf("</script>");
    if (endIdx === -1) return null;
    let json: unknown;
    try {
      json = JSON.parse(after.slice(0, endIdx));
    } catch {
      return null;
    }
    return this.parseNextData(json);
  }

  // Faithful TypeScript port of bookhive's parseGoodreadsData from
  // src/scrapers/moreInfo.ts. Their parser distinguishes "book_not_found_upstream"
  // vs "next_data_parse_failed" for a retry queue; we collapse both into null
  // because the BookProvider interface has no deferred-vs-dead retry concept.
  private parseNextData(json: unknown): BookData | null {
    try {
      const apolloState = (
        json as { props?: { pageProps?: { apolloState?: { ROOT_QUERY?: Record<string, unknown> } & Record<string, unknown> } } }
      )?.props?.pageProps?.apolloState;
      if (!apolloState?.ROOT_QUERY) return null;

      const bookQuery = Object.keys(apolloState.ROOT_QUERY).find((key) =>
        key.startsWith("getBookByLegacyId"),
      );
      if (!bookQuery) return null;
      const bookRef = apolloState.ROOT_QUERY[bookQuery];
      if (bookRef === null || bookRef === undefined) return null;
      const bookId = (bookRef as { __ref?: string }).__ref;
      if (!bookId) return null;
      const bookData = apolloState[bookId] as Record<string, unknown> | undefined;
      if (!bookData) return null;

      const workRef = (bookData.work as { __ref?: string } | undefined)?.__ref;
      const workData = workRef ? (apolloState[workRef] as Record<string, unknown>) : null;

      const authorRef = (bookData.primaryContributorEdge as { node?: { __ref?: string } } | undefined)?.node?.__ref;
      const authorData = authorRef ? (apolloState[authorRef] as Record<string, unknown>) : null;

      const seriesEdge = (bookData.bookSeries as Array<{ series?: { __ref?: string }; userPosition?: string }> | undefined)?.[0];
      const seriesRef = seriesEdge?.series?.__ref;
      const seriesData = seriesRef ? (apolloState[seriesRef] as Record<string, unknown>) : null;

      const bookGenres = bookData.bookGenres as Array<{ genre?: { name?: string } }> | undefined;
      const genres = (bookGenres ?? [])
        .map((bg) => bg.genre?.name)
        .filter((g): g is string => typeof g === "string")
        .slice(0, 5);

      const secondaryContributorEdges = bookData.secondaryContributorEdges as
        | Array<{ role?: string; node?: { __ref?: string } }>
        | undefined;
      const secondaryContributors: string[] = [];
      for (const edge of secondaryContributorEdges ?? []) {
        if (edge.role !== "Author") continue;
        const ref = edge.node?.__ref;
        if (!ref) continue;
        const node = apolloState[ref] as { name?: string } | undefined;
        if (node?.name) secondaryContributors.push(node.name);
      }

      const details = (bookData.details ?? {}) as Record<string, unknown>;
      const languageObj = details.language as { name?: string } | undefined;
      const publicationTime = details.publicationTime as string | undefined;
      const publicationYear =
        typeof publicationTime === "string"
          ? String(new Date(publicationTime).getFullYear())
          : undefined;

      const primaryAuthorName =
        typeof authorData?.name === "string" ? authorData.name : "";
      const authors = [primaryAuthorName, ...secondaryContributors].filter(Boolean);
      const author = authors.length > 0 ? authors.join(", ") : "Unknown";

      const identifiers: Record<string, string> = {};
      if (typeof bookData.id === "string") {
        identifiers["goodreads"] = bookData.id;
      }

      const imageUrl = typeof bookData.imageUrl === "string" ? bookData.imageUrl : undefined;

      // Defensive use of workData — currently unmapped but kept available for
      // future averageRating / ratingsCount fields.
      void workData;

      return {
        title: (bookData.titleComplete as string | undefined) ?? "Unknown Title",
        author,
        isbn10: typeof details.isbn === "string" ? details.isbn : undefined,
        isbn13: typeof details.isbn13 === "string" ? details.isbn13 : undefined,
        publishedDate: publicationYear,
        description: typeof bookData.description === "string" ? bookData.description : undefined,
        pageCount: typeof details.numPages === "number" ? details.numPages : undefined,
        language: languageObj?.name,
        publisher: typeof details.publisher === "string" ? details.publisher : undefined,
        categories: genres.length > 0 ? genres : undefined,
        coverUrl: imageUrl ? stripImageSizeSuffix(imageUrl) : undefined,
        identifiers,
        sourceProvider: "goodreads",
      };
    } catch {
      return null;
    }
  }

  private mapAutoCompleteHitToBookData(hit: GoodreadsAutoCompleteHit): BookData | null {
    const bookId = hit.bookId;
    if (!bookId) return null;

    const identifiers: Record<string, string> = {};
    identifiers["goodreads"] = bookId;

    return {
      title: hit.bookTitleBare ?? hit.title ?? "Unknown Title",
      author: hit.author?.name ?? "Unknown",
      publishedDate: undefined,
      description: hit.description?.html ? stripHtml(hit.description.html) : undefined,
      pageCount: typeof hit.numPages === "number" ? hit.numPages : undefined,
      language: undefined,
      publisher: undefined,
      categories: undefined,
      coverUrl: hit.imageUrl ? stripImageSizeSuffix(hit.imageUrl) : undefined,
      identifiers,
      sourceProvider: "goodreads",
    };
  }
}
