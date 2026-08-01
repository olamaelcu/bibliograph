CREATE TABLE IF NOT EXISTS `book_labels` (
	`src` text NOT NULL,
	`uri` text NOT NULL,
	`val` text NOT NULL,
	`cts` text NOT NULL,
	`neg` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`src`, `uri`, `val`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `book_labels_uri_idx` ON `book_labels` (`uri`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `book_labels_val_idx` ON `book_labels` (`val`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `books` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`isbn` text,
	`publishedDate` text,
	`description` text,
	`pageCount` integer,
	`language` text DEFAULT 'en',
	`categories` text DEFAULT '[]',
	`identifiers` text DEFAULT '[]',
	`coverUrl` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT "books_status_check" CHECK("books"."status" IN ('pending', 'active', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `books_isbn_unique` ON `books` (`isbn`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `books_title_idx` ON `books` (`title`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `books_author_idx` ON `books` (`author`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `books_status_idx` ON `books` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `claims` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`bookUri` text NOT NULL,
	`identifier` text NOT NULL,
	`identifierType` text NOT NULL,
	`claimedBy` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verifiedBy` text,
	`verifiedAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "claims_status_check" CHECK("claims"."status" IN ('pending', 'verified', 'rejected')),
	CONSTRAINT "claims_identifier_type_check" CHECK("claims"."identifierType" IN ('isbn', 'ean', 'issn', 'asin', 'oclc'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claims_book_uri_idx` ON `claims` (`bookUri`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claims_status_idx` ON `claims` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claims_claimed_by_idx` ON `claims` (`claimedBy`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `claims_identifier_idx` ON `claims` (`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `claims_book_claimed_by_unique` ON `claims` (`bookUri`,`claimedBy`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reading_statuses` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`bookUri` text NOT NULL,
	`status` text DEFAULT 'to-read' NOT NULL,
	`progress` real,
	`rating` real,
	`startedAt` text,
	`finishedAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reading_statuses_status_check" CHECK("reading_statuses"."status" IN ('reading', 'read', 'to-read', 'abandoned')),
	CONSTRAINT "reading_statuses_progress_check" CHECK("reading_statuses"."progress" IS NULL OR ("reading_statuses"."progress" >= 0 AND "reading_statuses"."progress" <= 100)),
	CONSTRAINT "reading_statuses_rating_check" CHECK("reading_statuses"."rating" IS NULL OR ("reading_statuses"."rating" >= 1 AND "reading_statuses"."rating" <= 5))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reading_statuses_book_uri_idx` ON `reading_statuses` (`bookUri`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reading_statuses_did_idx` ON `reading_statuses` (`did`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reading_statuses_status_idx` ON `reading_statuses` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reviews` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`bookUri` text NOT NULL,
	`text` text NOT NULL,
	`rating` real,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reviews_rating_check" CHECK("reviews"."rating" IS NULL OR ("reviews"."rating" >= 1 AND "reviews"."rating" <= 5))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reviews_book_uri_idx` ON `reviews` (`bookUri`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reviews_did_idx` ON `reviews` (`did`);