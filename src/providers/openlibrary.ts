import type { BookData, BookProvider } from "./interface.js";
import { BaseBookProvider } from "./base-provider.js";
import { buildCover, firstCoverVariant, olCoverVariantUrls } from "./cover-variants.js";
import type { Cover } from "../cover-types.js";

const BASE_URL = "https://openlibrary.org";
const USER_AGENT = "bibliograph-app/0.1 (contact@example.org)";

export interface AuthorSearchResult {
  docs: BookData[];
  total: number;
  page: number;
  limit: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class OpenLibraryProvider extends BaseBookProvider implements BookProvider {
  getName(): string {
    return "Open Library";
  }

  async searchByIsbn(isbn: string): Promise<BookData | null> {
    const data = await this.fetchJson<{ docs?: unknown[] }>(
      `${BASE_URL}/search.json?q=isbn:${encodeURIComponent(isbn)}&limit=1`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    const docs = data?.docs;
    if (!docs || docs.length === 0) return null;

    return this.mapDocToBookData(docs[0] as Record<string, unknown>);
  }

  async searchByTitle(title: string, author?: string): Promise<BookData[]> {
    let url = `${BASE_URL}/search.json?title=${encodeURIComponent(title)}&limit=10`;
    if (author) {
      url += `&author=${encodeURIComponent(author)}`;
    }

    const data = await this.fetchJson<{ docs?: unknown[] }>(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const docs = data?.docs;
    if (!docs || docs.length === 0) return [];

    return docs.map((doc) =>
      this.mapDocToBookData(doc as Record<string, unknown>),
    );
  }

  async searchByAuthorKey(
    authorKey: string,
    page = 1,
    limit = 100,
  ): Promise<AuthorSearchResult | null> {
    const url = `${BASE_URL}/search.json?author_key=${encodeURIComponent(authorKey)}&page=${page}&limit=${limit}`;
    const data = await this.fetchJson<{ numFound?: number; docs?: unknown[] }>(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const docs = data?.docs;
    if (!docs) return null;

    return {
      docs: docs.map((doc) =>
        this.mapDocToBookData(doc as Record<string, unknown>),
      ),
      total: data.numFound ?? 0,
      page,
      limit,
    };
  }

  async getBookDetails(id: string): Promise<BookData | null> {
    let url: string;
    if (id.startsWith("OL") && id.endsWith("W")) {
      url = `${BASE_URL}/works/${encodeURIComponent(id)}.json`;
    } else if (id.startsWith("OL") && id.endsWith("M")) {
      url = `${BASE_URL}/books/${encodeURIComponent(id)}.json`;
    } else {
      // Default to works endpoint
      url = `${BASE_URL}/works/${encodeURIComponent(id)}.json`;
    }

    const doc = await this.fetchJson<Record<string, unknown>>(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!doc) return null;

    return this.mapDocToBookData(doc);
  }

  private mapDocToBookData(doc: Record<string, unknown>): BookData {
    const authorName = this.extractAuthor(doc);

    const identifiers: Record<string, string> = {};
    const olKey =
      typeof doc.key === "string" ? doc.key : "";
    if (olKey) {
      identifiers["openlibrary"] = olKey;
    }
    const rawIds = doc.identifiers;
    if (rawIds && typeof rawIds === "object" && !Array.isArray(rawIds)) {
      for (const [k, v] of Object.entries(rawIds as Record<string, unknown>)) {
        if (typeof v === "string") {
          identifiers[k] = v;
        }
      }
    }

    const coverVariants = this.extractCoverVariants(doc);
    const cover: Cover | undefined = coverVariants
      ? buildCover("openlibrary", coverVariants)
      : undefined;

    return {
      title: (typeof doc.title === "string" ? doc.title : "") || "Unknown Title",
      author: authorName,
      isbn10: this.extractFirstString(
        doc.isbn as string[] | undefined,
      ) ?? this.extractFirstString(doc.isbn_10 as string[] | undefined),
      isbn13: this.extractFirstString(
        doc.isbn as string[] | undefined,
      ) ?? this.extractFirstString(doc.isbn_13 as string[] | undefined),
      publishedDate: (typeof doc.publish_date === "string"
        ? doc.publish_date
        : undefined) ?? (doc.first_publish_year
        ? String(doc.first_publish_year)
        : undefined),
      description: this.extractDescription(doc),
      pageCount:
        typeof doc.number_of_pages === "number"
          ? doc.number_of_pages
          : undefined,
      categories: this.extractSubjects(doc),
      coverUrl: this.extractCoverUrl(doc),
      cover,
      identifiers,
      sourceProvider: "openLibrary",
    };
  }

  private extractCoverVariants(doc: Record<string, unknown>): { small: string; medium: string; large: string } | undefined {
    const coverI = doc.cover_i as number | undefined;
    if (coverI) {
      const urls = olCoverVariantUrls(coverI);
      if (urls.small && urls.medium && urls.large) return urls;
    }
    const covers = doc.covers as number[] | undefined;
    if (covers?.[0]) {
      const urls = olCoverVariantUrls(covers[0]);
      if (urls.small && urls.medium && urls.large) return urls;
    }
    return undefined;
  }

  private extractAuthor(doc: Record<string, unknown>): string {
    const authorName = doc.author_name as string[] | undefined;
    if (authorName?.[0]) return authorName[0];

    const authors = doc.authors as
      | { name?: string }[]
      | undefined;
    if (authors?.[0]?.name) return authors[0].name;

    return "Unknown";
  }

  private extractDescription(doc: Record<string, unknown>): string | undefined {
    const desc = doc.description;
    if (typeof desc === "string") return desc;
    if (desc && typeof desc === "object") {
      const val = (desc as Record<string, unknown>).value;
      if (typeof val === "string") return val;
    }
    return undefined;
  }

  private extractSubjects(doc: Record<string, unknown>): string[] | undefined {
    const subject = doc.subject as string[] | undefined;
    if (subject && subject.length > 0) return subject.slice(0, 5);

    const subjects = doc.subjects as string[] | undefined;
    if (subjects && subjects.length > 0) return subjects.slice(0, 5);

    return undefined;
  }

  private extractCoverUrl(doc: Record<string, unknown>): string | undefined {
    const coverI = doc.cover_i as number | undefined;
    if (coverI) return firstCoverVariant(olCoverVariantUrls(coverI));

    const covers = doc.covers as number[] | undefined;
    if (covers?.[0]) return firstCoverVariant(olCoverVariantUrls(covers[0]));

    return undefined;
  }

  private extractFirstString(arr: string[] | undefined): string | undefined {
    if (!arr || arr.length === 0) return undefined;
    return arr[0];
  }
}
