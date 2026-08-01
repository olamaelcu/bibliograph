import type { BookData, BookProvider } from "./interface.js";

const BASE_URL = "https://openlibrary.org";
const USER_AGENT = "bibliograph-app/0.1 (contact@example.org)";

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class OpenLibraryProvider implements BookProvider {
  getName(): string {
    return "Open Library";
  }

  async searchByIsbn(isbn: string): Promise<BookData | null> {
    try {
      const response = await fetch(
        `${BASE_URL}/search.json?q=isbn:${encodeURIComponent(isbn)}&limit=1`,
        { headers: { "User-Agent": USER_AGENT } },
      );

      if (!response.ok) return null;

      const data = (await response.json()) as { docs?: unknown[] };
      const docs = data.docs;
      if (!docs || docs.length === 0) return null;

      return this.mapDocToBookData(docs[0] as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async searchByTitle(title: string, author?: string): Promise<BookData[]> {
    try {
      let url = `${BASE_URL}/search.json?title=${encodeURIComponent(title)}&limit=10`;
      if (author) {
        url += `&author=${encodeURIComponent(author)}`;
      }

      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { docs?: unknown[] };
      const docs = data.docs;
      if (!docs || docs.length === 0) return [];

      return docs.map((doc) =>
        this.mapDocToBookData(doc as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  }

  async getBookDetails(id: string): Promise<BookData | null> {
    try {
      let url: string;
      if (id.startsWith("OL") && id.endsWith("W")) {
        url = `${BASE_URL}/works/${encodeURIComponent(id)}.json`;
      } else if (id.startsWith("OL") && id.endsWith("M")) {
        url = `${BASE_URL}/books/${encodeURIComponent(id)}.json`;
      } else {
        // Default to works endpoint
        url = `${BASE_URL}/works/${encodeURIComponent(id)}.json`;
      }

      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) return null;

      const doc = (await response.json()) as Record<string, unknown>;
      return this.mapDocToBookData(doc);
    } catch {
      return null;
    }
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
      identifiers,
      sourceProvider: "openLibrary",
    };
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
    if (coverI) return `https://covers.openlibrary.org/b/id/${coverI}-M.jpg`;

    const covers = doc.covers as number[] | undefined;
    if (covers?.[0]) return `https://covers.openlibrary.org/b/id/${covers[0]}-M.jpg`;

    return undefined;
  }

  private extractFirstString(arr: string[] | undefined): string | undefined {
    if (!arr || arr.length === 0) return undefined;
    return arr[0];
  }
}
