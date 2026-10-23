CREATE TABLE "edition_work_votes" (
	"edition_uri" text NOT NULL,
	"voter_did" text NOT NULL,
	"action" text NOT NULL,
	"work_uri" text,
	"work_cid" text,
	"record_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_work_votes_edition_uri_voter_did_pk" PRIMARY KEY("edition_uri","voter_did")
);
--> statement-breakpoint
CREATE TABLE "oauth_sessions" (
	"did" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "work_link_source" text;--> statement-breakpoint
CREATE INDEX "edition_work_votes_edition_idx" ON "edition_work_votes" USING btree ("edition_uri");--> statement-breakpoint
CREATE INDEX "web_sessions_expires_at_idx" ON "web_sessions" USING btree ("expires_at");