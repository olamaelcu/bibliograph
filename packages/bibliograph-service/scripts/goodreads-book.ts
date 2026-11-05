#!/usr/bin/env tsx
//
// Print every display fact Goodreads exposes for one ISBN: pages, binding,
// ISBN-10/13, ASIN, publication date, publisher, language, genres, and
// contributors with their portrait URLs.
//
//   pnpm goodreads:book -- 9780691176512
//
// This is a diagnostic scraper, not a request-path dependency. Goodreads can
// answer with an anti-bot 202; in that case the command reports "not found".
//

import {
  fetchGoodreadsAuthor,
  fetchGoodreadsBook,
} from "../src/lib/server/api/goodreads";

async function main(): Promise<void> {
  const isbn = process.argv[2];
  if (!isbn) {
    console.error("usage: pnpm goodreads:book -- <isbn>");
    process.exit(2);
  }

  const book = await fetchGoodreadsBook(isbn);
  if (!book) {
    console.error(JSON.stringify({ event: "goodreads-book-not-found", isbn }));
    process.exit(1);
  }

  for (const contributor of book.contributors) {
    if (contributor.imageUrl) continue;
    const author = await fetchGoodreadsAuthor(contributor.url);
    if (author?.imageUrl) contributor.imageUrl = author.imageUrl;
  }

  console.log(JSON.stringify(book, null, 2));
}

main().catch((err) => {
  console.error("[goodreads-book] failed:", err);
  process.exit(1);
});
