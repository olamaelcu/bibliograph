-- Edition display metadata: physical/digital format and page count.
--
-- Both were already part of the edition vocabulary (`pages` on
-- `community.lexicon.book.edition`, `format` on the AppView's `bookView`), but
-- neither had a column behind it. Providers supply them: Open Library's edition
-- document carries `number_of_pages` and `physical_format`, ISBNDb carries
-- `pages` and `binding`, and Google Books carries `pageCount`. Storing the
-- normalized values lets `getBooks` answer the book page and shelf cards
-- without re-querying those providers.
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "format" text;
--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "pages" integer;
