CREATE TABLE "backfill_reservation" (
	"state_name" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"started_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backfill_state" (
	"name" text PRIMARY KEY NOT NULL,
	"url" text,
	"file_path" text,
	"last_modified" text,
	"file_size" integer,
	"last_byte_offset" integer,
	"cursor" text,
	"total_processed" integer,
	"total_records" integer,
	"complete" integer DEFAULT 0 NOT NULL,
	"stopped" integer DEFAULT 0 NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_contributor_staging" (
	"id" bigserial NOT NULL,
	"edition_ol_key" text NOT NULL,
	"author_ol_key" text NOT NULL,
	"role_pk" text DEFAULT 'author' NOT NULL,
	CONSTRAINT "book_contributor_staging_edition_ol_key_author_ol_key_role_pk_pk" PRIMARY KEY("edition_ol_key","author_ol_key","role_pk")
);
--> statement-breakpoint
CREATE TABLE "book_contributors" (
	"book_pk" text NOT NULL,
	"contributor_pk" text NOT NULL,
	"role_pk" text NOT NULL,
	"created_at" integer,
	CONSTRAINT "book_contributors_book_pk_contributor_pk_pk" PRIMARY KEY("book_pk","contributor_pk")
);
--> statement-breakpoint
CREATE TABLE "book_genres" (
	"book_pk" text NOT NULL,
	"genre_pk" text NOT NULL,
	CONSTRAINT "book_genres_book_pk_genre_pk_pk" PRIMARY KEY("book_pk","genre_pk")
);
--> statement-breakpoint
CREATE TABLE "book_identifiers" (
	"book_pk" text NOT NULL,
	"resource" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "book_identifiers_book_pk_resource_pk" PRIMARY KEY("book_pk","resource")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"pk" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"work_pk" text,
	"format_pk" text,
	"publish_date" integer,
	"description" text,
	"cover_url" text,
	"cid" text DEFAULT '' NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"release_status" text DEFAULT 'staged' NOT NULL,
	"released_at" integer,
	CONSTRAINT "books_release_status_check" CHECK ("books"."release_status" IN ('staged', 'released', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "catalog_blobs" (
	"pk" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_pk" text NOT NULL,
	"kind" text NOT NULL,
	"cid" text NOT NULL,
	"mime_type" text,
	"size" integer,
	"object_key" text NOT NULL,
	"source" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributor_identifiers" (
	"contributor_pk" text NOT NULL,
	"resource" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "contributor_identifiers_contributor_pk_resource_pk" PRIMARY KEY("contributor_pk","resource")
);
--> statement-breakpoint
CREATE TABLE "contributor_roles" (
	"pk" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon_image_url" text,
	"cid" text DEFAULT '' NOT NULL,
	"created_at" integer NOT NULL,
	"release_status" text DEFAULT 'staged' NOT NULL,
	"released_at" integer,
	CONSTRAINT "contributor_roles_release_status_check" CHECK ("contributor_roles"."release_status" IN ('staged', 'released', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"pk" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_name" text,
	"bio" text,
	"image_url" text,
	"cid" text DEFAULT '' NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"release_status" text DEFAULT 'staged' NOT NULL,
	"released_at" integer,
	CONSTRAINT "contributors_release_status_check" CHECK ("contributors"."release_status" IN ('staged', 'released', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "formats" (
	"pk" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"emoji" text NOT NULL,
	"icon_image_url" text,
	"unit" text NOT NULL,
	"cid" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genre_children" (
	"parent_pk" text NOT NULL,
	"child_pk" text NOT NULL,
	CONSTRAINT "genre_children_parent_pk_child_pk_pk" PRIMARY KEY("parent_pk","child_pk")
);
--> statement-breakpoint
CREATE TABLE "genre_identifiers" (
	"genre_pk" text NOT NULL,
	"resource" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "genre_identifiers_genre_pk_resource_pk" PRIMARY KEY("genre_pk","resource")
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"pk" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"emoji" text NOT NULL,
	"icon_image_url" text,
	"parent_pk" text,
	"cid" text DEFAULT '' NOT NULL,
	"created_at" integer NOT NULL,
	"release_status" text DEFAULT 'staged' NOT NULL,
	"released_at" integer,
	CONSTRAINT "genres_release_status_check" CHECK ("genres"."release_status" IN ('staged', 'released', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "import_issues" (
	"pk" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_pk" text NOT NULL,
	"field" text NOT NULL,
	"incoming_value" text,
	"stored_value" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" integer NOT NULL,
	"resolved_at" integer,
	CONSTRAINT "import_issues_entity_type_check" CHECK ("import_issues"."entity_type" IN ('book', 'work', 'contributor', 'genre', 'contributorRole')),
	CONSTRAINT "import_issues_status_check" CHECK ("import_issues"."status" IN ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "jetstream_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" integer,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_records" (
	"did" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"cid" text NOT NULL,
	"record" jsonb NOT NULL,
	"indexed_at" integer NOT NULL,
	CONSTRAINT "user_records_did_collection_rkey_pk" PRIMARY KEY("did","collection","rkey")
);
--> statement-breakpoint
CREATE TABLE "work_identifiers" (
	"work_pk" text NOT NULL,
	"resource" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "work_identifiers_work_pk_resource_pk" PRIMARY KEY("work_pk","resource")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"pk" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"original_publish_date" integer,
	"cid" text DEFAULT '' NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"release_status" text DEFAULT 'staged' NOT NULL,
	"released_at" integer,
	CONSTRAINT "works_release_status_check" CHECK ("works"."release_status" IN ('staged', 'released', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "book_contributors" ADD CONSTRAINT "book_contributors_book_pk_books_pk_fk" FOREIGN KEY ("book_pk") REFERENCES "public"."books"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_contributors" ADD CONSTRAINT "book_contributors_contributor_pk_contributors_pk_fk" FOREIGN KEY ("contributor_pk") REFERENCES "public"."contributors"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_contributors" ADD CONSTRAINT "book_contributors_role_pk_contributor_roles_pk_fk" FOREIGN KEY ("role_pk") REFERENCES "public"."contributor_roles"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_genres" ADD CONSTRAINT "book_genres_book_pk_books_pk_fk" FOREIGN KEY ("book_pk") REFERENCES "public"."books"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_genres" ADD CONSTRAINT "book_genres_genre_pk_genres_pk_fk" FOREIGN KEY ("genre_pk") REFERENCES "public"."genres"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_identifiers" ADD CONSTRAINT "book_identifiers_book_pk_books_pk_fk" FOREIGN KEY ("book_pk") REFERENCES "public"."books"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_work_pk_works_pk_fk" FOREIGN KEY ("work_pk") REFERENCES "public"."works"("pk") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_format_pk_formats_pk_fk" FOREIGN KEY ("format_pk") REFERENCES "public"."formats"("pk") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_identifiers" ADD CONSTRAINT "contributor_identifiers_contributor_pk_contributors_pk_fk" FOREIGN KEY ("contributor_pk") REFERENCES "public"."contributors"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genre_children" ADD CONSTRAINT "genre_children_parent_pk_genres_pk_fk" FOREIGN KEY ("parent_pk") REFERENCES "public"."genres"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genre_children" ADD CONSTRAINT "genre_children_child_pk_genres_pk_fk" FOREIGN KEY ("child_pk") REFERENCES "public"."genres"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genre_identifiers" ADD CONSTRAINT "genre_identifiers_genre_pk_genres_pk_fk" FOREIGN KEY ("genre_pk") REFERENCES "public"."genres"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genres" ADD CONSTRAINT "genres_parent_pk_genres_pk_fk" FOREIGN KEY ("parent_pk") REFERENCES "public"."genres"("pk") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_identifiers" ADD CONSTRAINT "work_identifiers_work_pk_works_pk_fk" FOREIGN KEY ("work_pk") REFERENCES "public"."works"("pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_genres_genre_pk_idx" ON "book_genres" USING btree ("genre_pk");--> statement-breakpoint
CREATE INDEX "book_identifiers_url_idx" ON "book_identifiers" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "book_identifiers_resource_unique" ON "book_identifiers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "books_work_pk_idx" ON "books" USING btree ("work_pk");--> statement-breakpoint
CREATE INDEX "books_format_pk_idx" ON "books" USING btree ("format_pk");--> statement-breakpoint
CREATE INDEX "books_release_status_idx" ON "books" USING btree ("release_status");--> statement-breakpoint
CREATE INDEX "catalog_blobs_entity_idx" ON "catalog_blobs" USING btree ("entity_type","entity_pk");--> statement-breakpoint
CREATE INDEX "contributor_identifiers_url_idx" ON "contributor_identifiers" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "contributor_identifiers_resource_unique" ON "contributor_identifiers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "contributor_roles_release_status_idx" ON "contributor_roles" USING btree ("release_status");--> statement-breakpoint
CREATE INDEX "contributors_name_idx" ON "contributors" USING btree ("name");--> statement-breakpoint
CREATE INDEX "contributors_release_status_idx" ON "contributors" USING btree ("release_status");--> statement-breakpoint
CREATE INDEX "genre_children_child_pk_idx" ON "genre_children" USING btree ("child_pk");--> statement-breakpoint
CREATE INDEX "genre_identifiers_url_idx" ON "genre_identifiers" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "genre_identifiers_resource_unique" ON "genre_identifiers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "genres_name_idx" ON "genres" USING btree ("name");--> statement-breakpoint
CREATE INDEX "genres_parent_pk_idx" ON "genres" USING btree ("parent_pk");--> statement-breakpoint
CREATE INDEX "genres_release_status_idx" ON "genres" USING btree ("release_status");--> statement-breakpoint
CREATE INDEX "import_issues_entity_idx" ON "import_issues" USING btree ("entity_type","entity_pk");--> statement-breakpoint
CREATE INDEX "import_issues_status_idx" ON "import_issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_records_collection_idx" ON "user_records" USING btree ("collection");--> statement-breakpoint
CREATE INDEX "user_records_did_collection_idx" ON "user_records" USING btree ("did","collection");--> statement-breakpoint
CREATE INDEX "work_identifiers_url_idx" ON "work_identifiers" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "work_identifiers_resource_unique" ON "work_identifiers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "works_title_idx" ON "works" USING btree ("title");--> statement-breakpoint
CREATE INDEX "works_title_lower_idx" ON "works" USING btree (lower("title"));--> statement-breakpoint
CREATE INDEX "works_release_status_idx" ON "works" USING btree ("release_status");--> statement-breakpoint
CREATE VIEW "book_import_issues" AS
SELECT b.*, ii.open_issues
FROM "books" b
JOIN (
	SELECT entity_pk, COALESCE(json_agg(json_build_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk), '[]'::json) AS open_issues
	FROM "import_issues"
	WHERE entity_type = 'book' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = b.pk;
--> statement-breakpoint
CREATE VIEW "work_import_issues" AS
SELECT w.*, ii.open_issues
FROM "works" w
JOIN (
	SELECT entity_pk, COALESCE(json_agg(json_build_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk), '[]'::json) AS open_issues
	FROM "import_issues"
	WHERE entity_type = 'work' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = w.pk;
--> statement-breakpoint
CREATE VIEW "contributor_import_issues" AS
SELECT c.*, ii.open_issues
FROM "contributors" c
JOIN (
	SELECT entity_pk, COALESCE(json_agg(json_build_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk), '[]'::json) AS open_issues
	FROM "import_issues"
	WHERE entity_type = 'contributor' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = c.pk;
--> statement-breakpoint
CREATE VIEW "genre_import_issues" AS
SELECT g.*, ii.open_issues
FROM "genres" g
JOIN (
	SELECT entity_pk, COALESCE(json_agg(json_build_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk), '[]'::json) AS open_issues
	FROM "import_issues"
	WHERE entity_type = 'genre' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = g.pk;
--> statement-breakpoint
CREATE VIEW "contributor_role_import_issues" AS
SELECT cr.*, ii.open_issues
FROM "contributor_roles" cr
JOIN (
	SELECT entity_pk, COALESCE(json_agg(json_build_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk), '[]'::json) AS open_issues
	FROM "import_issues"
	WHERE entity_type = 'contributorRole' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = cr.pk;
