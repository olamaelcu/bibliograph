CREATE TABLE `author_identifiers` (
	`author_pk` text NOT NULL,
	`resource` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`author_pk`, `resource`),
	FOREIGN KEY (`author_pk`) REFERENCES `authors`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `author_identifiers_url_idx` ON `author_identifiers` (`url`);--> statement-breakpoint
CREATE TABLE `authors` (
	`pk` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_name` text,
	`bio` text,
	`image_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `authors_name_idx` ON `authors` (`name`);--> statement-breakpoint
CREATE TABLE `book_contributors` (
	`book_pk` text NOT NULL,
	`contributor_pk` text NOT NULL,
	`role_pk` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`book_pk`, `contributor_pk`),
	FOREIGN KEY (`book_pk`) REFERENCES `books`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contributor_pk`) REFERENCES `authors`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_pk`) REFERENCES `contributor_roles`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_genres` (
	`book_pk` text NOT NULL,
	`genre_pk` text NOT NULL,
	PRIMARY KEY(`book_pk`, `genre_pk`),
	FOREIGN KEY (`book_pk`) REFERENCES `books`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`genre_pk`) REFERENCES `genres`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_genres_genre_pk_idx` ON `book_genres` (`genre_pk`);--> statement-breakpoint
CREATE TABLE `book_identifiers` (
	`book_pk` text NOT NULL,
	`resource` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`book_pk`, `resource`),
	FOREIGN KEY (`book_pk`) REFERENCES `books`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_identifiers_url_idx` ON `book_identifiers` (`url`);--> statement-breakpoint
CREATE TABLE `books` (
	`pk` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`work_pk` text,
	`format_pk` text,
	`publish_date` integer,
	`description` text,
	`cover_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`work_pk`) REFERENCES `works`(`pk`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`format_pk`) REFERENCES `formats`(`pk`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `books_work_pk_idx` ON `books` (`work_pk`);--> statement-breakpoint
CREATE INDEX `books_format_pk_idx` ON `books` (`format_pk`);--> statement-breakpoint
CREATE TABLE `contributor_roles` (
	`pk` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`icon_image_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `formats` (
	`pk` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`emoji` text NOT NULL,
	`icon_image_url` text,
	`unit` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `genre_children` (
	`parent_pk` text NOT NULL,
	`child_pk` text NOT NULL,
	PRIMARY KEY(`parent_pk`, `child_pk`),
	FOREIGN KEY (`parent_pk`) REFERENCES `genres`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_pk`) REFERENCES `genres`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `genre_children_child_pk_idx` ON `genre_children` (`child_pk`);--> statement-breakpoint
CREATE TABLE `genre_identifiers` (
	`genre_pk` text NOT NULL,
	`resource` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`genre_pk`, `resource`),
	FOREIGN KEY (`genre_pk`) REFERENCES `genres`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `genre_identifiers_url_idx` ON `genre_identifiers` (`url`);--> statement-breakpoint
CREATE TABLE `genres` (
	`pk` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`emoji` text NOT NULL,
	`icon_image_url` text,
	`parent_pk` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_pk`) REFERENCES `genres`(`pk`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `genres_name_idx` ON `genres` (`name`);--> statement-breakpoint
CREATE INDEX `genres_parent_pk_idx` ON `genres` (`parent_pk`);--> statement-breakpoint
CREATE TABLE `shelves` (
	`pk` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon_image_cid` text,
	`header_image_cid` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `work_identifiers` (
	`work_pk` text NOT NULL,
	`resource` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`work_pk`, `resource`),
	FOREIGN KEY (`work_pk`) REFERENCES `works`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_identifiers_url_idx` ON `work_identifiers` (`url`);--> statement-breakpoint
CREATE TABLE `works` (
	`pk` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`original_publish_date` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `works_title_idx` ON `works` (`title`);