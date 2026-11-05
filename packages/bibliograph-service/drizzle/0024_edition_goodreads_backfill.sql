CREATE TABLE IF NOT EXISTS "edition_goodreads_backfill" (
	"uri" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_goodreads_backfill_uri_editions_uri_fk" FOREIGN KEY ("uri") REFERENCES "public"."editions"("uri") ON DELETE cascade ON UPDATE no action
);
