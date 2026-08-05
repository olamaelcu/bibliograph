export interface BookData {
  title: string;
  author: string;
  isbn10?: string;
  isbn13?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  publisher?: string;
  categories?: string[];
  coverUrl?: string;
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
