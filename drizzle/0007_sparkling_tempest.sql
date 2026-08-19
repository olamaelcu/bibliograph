CREATE TABLE "book_work_staging" (
	"book_pk" text PRIMARY KEY NOT NULL,
	"work_ol_key" text NOT NULL,
	"source" text NOT NULL,
	"created_at" integer NOT NULL
);--> statement-breakpoint
CREATE INDEX "book_work_staging_work_ol_key_idx" ON "book_work_staging" ("work_ol_key");
