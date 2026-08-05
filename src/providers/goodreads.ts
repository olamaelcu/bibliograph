import type { BookData, BookProvider } from "./interface.js";
import { BaseBookProvider } from "./base-provider.js";

const BASE_URL = "https://www.goodreads.com";
const AUTO_COMPLETE_URL = `${BASE_URL}/book/auto_complete`;

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
    const url = `${AUTO_COMPLETE_URL}?format=json&q=${encodeURIComponent(isbn)}&limit=20`;
    const data = await this.fetchJson<GoodreadsAutoCompleteHit[]>(url);
    if (!data || data.length === 0) return null;
    return this.mapAutoCompleteHitToBookData(data[0]);
  }

  async searchByTitle(_title: string, _author?: string): Promise<BookData[]> {
    return [];
  }

  async getBookDetails(_id: string): Promise<BookData | null> {
    return null;
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
      description: hit.description?.html
        ? stripHtml(hit.description.html)
        : undefined,
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
