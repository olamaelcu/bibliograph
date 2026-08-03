import type { BookData, BookProvider } from "./interface.js";
import { BaseBookProvider } from "./base-provider.js";

const BASE_URL = "https://www.googleapis.com/books/v1/volumes";

interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  publisher?: string;
  categories?: string[];
  industryIdentifiers?: Array<{
    type?: string;
    identifier?: string;
  }>;
  imageLinks?: {
    thumbnail?: string;
    smallThumbnail?: string;
  };
}

interface GoogleVolumeItem {
  id?: string;
  volumeInfo?: GoogleVolumeInfo;
}

interface GoogleSearchResponse {
  totalItems?: number;
  items?: GoogleVolumeItem[];
}

export interface GoogleAuthorSearchResult {
  items: BookData[];
  totalItems: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class GoogleBooksProvider extends BaseBookProvider implements BookProvider {
  #apiKey: string;

  constructor(apiKey: string) {
    super();
    this.#apiKey = apiKey;
  }

  getName(): string {
    return "Google Books";
  }

  async searchByIsbn(isbn: string): Promise<BookData | null> {
    const url = `${BASE_URL}?q=isbn:${encodeURIComponent(isbn)}&key=${this.#apiKey}&maxResults=1`;
    const data = await this.fetchJson<GoogleSearchResponse>(url);
    const items = data?.items;
    if (!items || items.length === 0) return null;

    return this.mapItemToBookData(items[0]);
  }

  async searchByTitle(title: string, author?: string): Promise<BookData[]> {
    let query = `intitle:${encodeURIComponent(title)}`;
    if (author) {
      query += `+inauthor:${encodeURIComponent(author)}`;
    }

    const url = `${BASE_URL}?q=${query}&key=${this.#apiKey}&maxResults=10`;
    const data = await this.fetchJson<GoogleSearchResponse>(url);
    const items = data?.items;
    if (!items || items.length === 0) return [];

    return items.map((item) => this.mapItemToBookData(item));
  }

  async getBookDetails(id: string): Promise<BookData | null> {
    const url = `${BASE_URL}/${encodeURIComponent(id)}?key=${this.#apiKey}`;
    const item = await this.fetchJson<GoogleVolumeItem>(url);
    if (!item) return null;

    return this.mapItemToBookData(item);
  }

  async searchByAuthorName(
    name: string,
    startIndex = 0,
    maxResults = 40,
  ): Promise<GoogleAuthorSearchResult | null> {
    const url = `${BASE_URL}?q=inauthor:${encodeURIComponent(name)}&startIndex=${startIndex}&maxResults=${maxResults}&key=${this.#apiKey}`;
    const data = await this.fetchJson<GoogleSearchResponse>(url);
    if (!data) return null;
    const items = data.items ?? [];

    return {
      items: items.map((item) => this.mapItemToBookData(item)),
      totalItems: data.totalItems ?? 0,
    };
  }

  private mapItemToBookData(item: GoogleVolumeItem): BookData {
    const vi = item.volumeInfo ?? {};

    const identifiers: Record<string, string> = {};
    if (item.id) {
      identifiers["googleBooks"] = item.id;
    }

    return {
      title: vi.title ?? "Unknown Title",
      author: vi.authors?.join(", ") ?? "Unknown",
      isbn10: this.findIsbn(vi, "ISBN_10"),
      isbn13: this.findIsbn(vi, "ISBN_13"),
      publishedDate: vi.publishedDate,
      description: vi.description,
      pageCount: vi.pageCount,
      language: vi.language,
      publisher: vi.publisher,
      categories: vi.categories,
      coverUrl:
        vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail,
      identifiers,
      sourceProvider: "googleBooks",
    };
  }

  private findIsbn(
    vi: GoogleVolumeInfo,
    type: string,
  ): string | undefined {
    const ids = vi.industryIdentifiers;
    if (!ids) return undefined;
    for (const entry of ids) {
      if (entry.type === type && entry.identifier) {
        return entry.identifier;
      }
    }
    return undefined;
  }
}
