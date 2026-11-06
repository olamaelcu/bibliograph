-- Works backfill bookkeeping.
--
-- The reconciler links an edition to a work only when OpenLibrary returns a
-- matching work; most editions get no match. Without a row saying "asked, no
-- match" every run re-queries the whole catalog — roughly a day of OpenLibrary
-- calls to learn the same answer. `status` is 'unmatched' for a genuine miss;
-- a lookup that never happened is never recorded, so those rows stay eligible.
CREATE TABLE IF NOT EXISTS "edition_work_backfill" (
	"uri" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_work_backfill_uri_editions_uri_fk" FOREIGN KEY ("uri") REFERENCES "public"."editions"("uri") ON DELETE cascade ON UPDATE no action
);
