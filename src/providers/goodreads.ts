import type { BookData, BookProvider } from "./interface.js";
import { BaseBookProvider } from "./base-provider.js";

// biome-ignore lint/complexity/noStaticOnlyClass: implements BookProvider interface
export class GoodreadsProvider extends BaseBookProvider implements BookProvider {
  getName(): string {
    return "Goodreads";
  }

  async searchByIsbn(_isbn: string): Promise<BookData | null> {
    return null;
  }

  async searchByTitle(_title: string, _author?: string): Promise<BookData[]> {
    return [];
  }

  async getBookDetails(_id: string): Promise<BookData | null> {
    return null;
  }
}
