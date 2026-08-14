CREATE TABLE `backfill_reservation` (
	`state_name` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backfill_state` (
	`name` text PRIMARY KEY NOT NULL,
	`url` text,
	`file_path` text,
	`last_modified` text,
	`file_size` integer,
	`last_byte_offset` integer,
	`cursor` text,
	`total_processed` integer,
	`complete` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_blobs` (
	`pk` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_pk` text NOT NULL,
	`kind` text NOT NULL,
	`cid` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`object_key` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_blobs_entity_idx` ON `catalog_blobs` (`entity_type`,`entity_pk`);--> statement-breakpoint
CREATE TABLE `import_issues` (
	`pk` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_pk` text NOT NULL,
	`field` text NOT NULL,
	`incoming_value` text,
	`stored_value` text,
	`source` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "import_issues_entity_type_check" CHECK("import_issues"."entity_type" IN ('book', 'work', 'contributor', 'genre', 'contributorRole')),
	CONSTRAINT "import_issues_status_check" CHECK("import_issues"."status" IN ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX `import_issues_entity_idx` ON `import_issues` (`entity_type`,`entity_pk`);--> statement-breakpoint
CREATE INDEX `import_issues_status_idx` ON `import_issues` (`status`);--> statement-breakpoint
ALTER TABLE `books` ADD `release_status` text DEFAULT 'staged' NOT NULL CONSTRAINT "books_release_status_check" CHECK("books"."release_status" IN ('staged', 'released', 'rejected'));--> statement-breakpoint
ALTER TABLE `books` ADD `released_at` integer;--> statement-breakpoint
CREATE INDEX `books_release_status_idx` ON `books` (`release_status`);--> statement-breakpoint
ALTER TABLE `contributor_roles` ADD `release_status` text DEFAULT 'staged' NOT NULL CONSTRAINT "contributor_roles_release_status_check" CHECK("contributor_roles"."release_status" IN ('staged', 'released', 'rejected'));--> statement-breakpoint
ALTER TABLE `contributor_roles` ADD `released_at` integer;--> statement-breakpoint
CREATE INDEX `contributor_roles_release_status_idx` ON `contributor_roles` (`release_status`);--> statement-breakpoint
ALTER TABLE `genres` ADD `release_status` text DEFAULT 'staged' NOT NULL CONSTRAINT "genres_release_status_check" CHECK("genres"."release_status" IN ('staged', 'released', 'rejected'));--> statement-breakpoint
ALTER TABLE `genres` ADD `released_at` integer;--> statement-breakpoint
CREATE INDEX `genres_release_status_idx` ON `genres` (`release_status`);--> statement-breakpoint
ALTER TABLE `works` ADD `release_status` text DEFAULT 'staged' NOT NULL CONSTRAINT "works_release_status_check" CHECK("works"."release_status" IN ('staged', 'released', 'rejected'));--> statement-breakpoint
ALTER TABLE `works` ADD `released_at` integer;--> statement-breakpoint
CREATE INDEX `works_release_status_idx` ON `works` (`release_status`);--> statement-breakpoint
ALTER TABLE `contributors` ADD `release_status` text DEFAULT 'staged' NOT NULL CONSTRAINT "contributors_release_status_check" CHECK("contributors"."release_status" IN ('staged', 'released', 'rejected'));--> statement-breakpoint
ALTER TABLE `contributors` ADD `released_at` integer;--> statement-breakpoint
CREATE INDEX `contributors_release_status_idx` ON `contributors` (`release_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `book_identifiers_resource_unique` ON `book_identifiers` (`resource`);--> statement-breakpoint
CREATE UNIQUE INDEX `genre_identifiers_resource_unique` ON `genre_identifiers` (`resource`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_identifiers_resource_unique` ON `work_identifiers` (`resource`);--> statement-breakpoint
CREATE UNIQUE INDEX `contributor_identifiers_resource_unique` ON `contributor_identifiers` (`resource`);
--> statement-breakpoint
CREATE VIEW `book_import_issues` AS
SELECT b.*, ii.open_issues
FROM `books` b
JOIN (
	SELECT entity_pk, json_group_array(json_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk) AS open_issues
	FROM `import_issues`
	WHERE entity_type = 'book' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = b.pk;
--> statement-breakpoint
CREATE VIEW `work_import_issues` AS
SELECT w.*, ii.open_issues
FROM `works` w
JOIN (
	SELECT entity_pk, json_group_array(json_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk) AS open_issues
	FROM `import_issues`
	WHERE entity_type = 'work' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = w.pk;
--> statement-breakpoint
CREATE VIEW `contributor_import_issues` AS
SELECT c.*, ii.open_issues
FROM `contributors` c
JOIN (
	SELECT entity_pk, json_group_array(json_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk) AS open_issues
	FROM `import_issues`
	WHERE entity_type = 'contributor' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = c.pk;
--> statement-breakpoint
CREATE VIEW `genre_import_issues` AS
SELECT g.*, ii.open_issues
FROM `genres` g
JOIN (
	SELECT entity_pk, json_group_array(json_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk) AS open_issues
	FROM `import_issues`
	WHERE entity_type = 'genre' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = g.pk;
--> statement-breakpoint
CREATE VIEW `contributor_role_import_issues` AS
SELECT cr.*, ii.open_issues
FROM `contributor_roles` cr
JOIN (
	SELECT entity_pk, json_group_array(json_object(
		'pk', pk,
		'field', field,
		'incomingValue', incoming_value,
		'storedValue', stored_value,
		'source', source,
		'createdAt', created_at
	) ORDER BY created_at, pk) AS open_issues
	FROM `import_issues`
	WHERE entity_type = 'contributorRole' AND status = 'open'
	GROUP BY entity_pk
) ii ON ii.entity_pk = cr.pk;
