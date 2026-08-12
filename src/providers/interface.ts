import type { Cover } from '../cover-types.js';

export interface BookContributor {
  name: string;
  key?: string;
  role?: string;
  order?: number;
}

export interface BookData {
  title: string;
  contributors: BookContributor[];
  isbn10?: string;
  isbn13?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  publisher?: string;
  categories?: string[];
  coverUrl?: string;
  cover?: Cover;
  identifiers: Record<string, string>;
  sourceProvider: string;
}

export interface BookProvider {
  searchByIsbn(isbn: string): Promise<BookData | null>;
  searchByTitle(title: string, author?: string): Promise<BookData[]>;
  getBookDetails(id: string): Promise<BookData | null>;
  getName(): string;
}

export type Providers = {
  openLibrary: BookProvider;
  googleBooks?: BookProvider;
  goodreads: BookProvider;
};

/** First contributor's display name, or '' if BookData has none. Use this
 *  wherever the legacy denormalized `books.author` TEXT column is populated. */
export function primaryAuthor(book: BookData): string {
  return book.contributors[0]?.name ?? '';
}
