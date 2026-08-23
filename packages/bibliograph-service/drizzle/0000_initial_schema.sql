-- Bibliograph AppView schema.
--
-- Tables (one per ATProto record type):
--   editions     — community.lexicon.book.edition
--   works        — community.lexicon.book.work
--   contributors — community.lexicon.book.contributor
--   publishers   — community.lexicon.book.publisher
--
-- Cross-record references use strongRef (uri + cid). FK relationships:
--   editions.work_uri       -> works.uri
--   editions.publisher_uri   -> publishers.uri
--   publishers.imprint_of_uri -> publishers.uri   (self-ref for imprints)

CREATE TABLE "editions" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"rkey" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"work_uri" text,
	"work_cid" text,
	"publisher_uri" text,
	"publisher_cid" text,
	"place" text,
	"published_year" integer,
	"language" text,
	"contributors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "works" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"rkey" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"original_language" text,
	"first_published_year" integer,
	"subjects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contributors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "contributors" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"rkey" text NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_did" text,
	"bio" text,
	"born_year" integer,
	"died_year" integer,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "publishers" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"rkey" text NOT NULL,
	"name" text NOT NULL,
	"imprint_of_uri" text,
	"imprint_of_cid" text,
	"founding_date" integer,
	"closing_date" integer,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Cross-record FKs
ALTER TABLE "editions" ADD CONSTRAINT "editions_work_uri_fk"
  FOREIGN KEY ("work_uri") REFERENCES "public"."works"("uri")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "editions" ADD CONSTRAINT "editions_publisher_uri_fk"
  FOREIGN KEY ("publisher_uri") REFERENCES "public"."publishers"("uri")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "publishers" ADD CONSTRAINT "publishers_imprint_of_uri_fk"
  FOREIGN KEY ("imprint_of_uri") REFERENCES "public"."publishers"("uri")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Indexes
CREATE INDEX "editions_indexed_at_idx" ON "editions" USING btree ("indexed_at");
--> statement-breakpoint
CREATE INDEX "editions_did_idx" ON "editions" USING btree ("did");
--> statement-breakpoint
CREATE INDEX "works_did_idx" ON "works" USING btree ("did");
--> statement-breakpoint
CREATE INDEX "works_indexed_at_idx" ON "works" USING btree ("indexed_at");
--> statement-breakpoint
CREATE INDEX "contributors_did_idx" ON "contributors" USING btree ("did");
--> statement-breakpoint
CREATE INDEX "contributors_indexed_at_idx" ON "contributors" USING btree ("indexed_at");
--> statement-breakpoint
CREATE INDEX "publishers_did_idx" ON "publishers" USING btree ("did");
--> statement-breakpoint
CREATE INDEX "publishers_indexed_at_idx" ON "publishers" USING btree ("indexed_at");
--> statement-breakpoint

-- Identifier views — flatten each record's `identifiers` jsonb array so callers
-- can SELECT * FROM editions_identifiers WHERE identifier_resource = 'isbn'
-- without unnest boilerplate.
CREATE VIEW "editions_identifiers" AS
  SELECT
    "uri",
    (identifier ->> 'uri')::text       AS identifier_uri,
    (identifier ->> 'resource')::text  AS identifier_resource
  FROM "editions",
       jsonb_array_elements("editions"."identifiers") AS identifier;
--> statement-breakpoint

CREATE VIEW "works_identifiers" AS
  SELECT
    "uri",
    (identifier ->> 'uri')::text       AS identifier_uri,
    (identifier ->> 'resource')::text  AS identifier_resource
  FROM "works",
       jsonb_array_elements("works"."identifiers") AS identifier;
--> statement-breakpoint

CREATE VIEW "contributors_identifiers" AS
  SELECT
    "uri",
    (identifier ->> 'uri')::text       AS identifier_uri,
    (identifier ->> 'resource')::text  AS identifier_resource
  FROM "contributors",
       jsonb_array_elements("contributors"."identifiers") AS identifier;
--> statement-breakpoint

CREATE VIEW "publishers_identifiers" AS
  SELECT
    "uri",
    (identifier ->> 'uri')::text       AS identifier_uri,
    (identifier ->> 'resource')::text  AS identifier_resource
  FROM "publishers",
       jsonb_array_elements("publishers"."identifiers") AS identifier;
