import type { BookData, BookProvider } from "./interface.js";

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
  items?: GoogleVolumeItem[];
}

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class GoogleBooksProvider implements BookProvider {
  #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  getName(): string {
    return "Google Books";
  }

  async searchByIsbn(isbn: string): Promise<BookData | null> {
    try {
      const url = `${BASE_URL}?q=isbn:${encodeURIComponent(isbn)}&key=${this.#apiKey}&maxResults=1`;
      const response = await fetch(url);

      if (!response.ok) return null;

      const data = (await response.json()) as GoogleSearchResponse;
      const items = data.items;
      if (!items || items.length === 0) return null;

      return this.mapItemToBookData(items[0]);
    } catch {
      return null;
    }
  }

  async searchByTitle(title: string, author?: string): Promise<BookData[]> {
    try {
      let query = `intitle:${encodeURIComponent(title)}`;
      if (author) {
        query += `+inauthor:${encodeURIComponent(author)}`;
      }

      const url = `${BASE_URL}?q=${query}&key=${this.#apiKey}&maxResults=10`;
      const response = await fetch(url);

      if (!response.ok) return [];

      const data = (await response.json()) as GoogleSearchResponse;
      const items = data.items;
      if (!items || items.length === 0) return [];

      return items.map((item) => this.mapItemToBookData(item));
    } catch {
      return [];
    }
  }

  async getBookDetails(id: string): Promise<BookData | null> {
    try {
      const url = `${BASE_URL}/${encodeURIComponent(id)}?key=${this.#apiKey}`;
      const response = await fetch(url);

      if (!response.ok) return null;

      const item = (await response.json()) as GoogleVolumeItem;
      return this.mapItemToBookData(item);
    } catch {
      return null;
    }
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
