-- ISBNdb responses, cached the same way as `google_books_cache` (0031 is the
-- GIN index; this one is the cache the search path now shares between the web
-- process, the worker and the backfill scripts).
--
-- `key` is sha256 over method + normalized URL + request body: the same path is
-- two different questions for `GET /book/{isbn}` and `POST /books` (a set of
-- ISBNs in the body), so both have to be part of the identity. A NULL `body` is
-- a negative entry — upstream answered "no such ISBN", which is worth
-- remembering for the same TTL as a hit.
CREATE TABLE IF NOT EXISTS "isbndb_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"request" text NOT NULL,
	"body" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "isbndb_cache_expires_at_idx" ON "isbndb_cache" USING btree ("expires_at");
