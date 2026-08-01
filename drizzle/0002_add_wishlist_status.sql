PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reading_statuses` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`bookUri` text NOT NULL,
	`status` text DEFAULT 'to-read' NOT NULL,
	`progress` real,
	`rating` real,
	`book_title` text NOT NULL,
	`book_author` text NOT NULL,
	`startedAt` text,
	`finishedAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reading_statuses_status_check" CHECK("__new_reading_statuses"."status" IN ('reading', 'read', 'to-read', 'abandoned', 'wishlist')),
	CONSTRAINT "reading_statuses_progress_check" CHECK("__new_reading_statuses"."progress" IS NULL OR ("__new_reading_statuses"."progress" >= 0 AND "__new_reading_statuses"."progress" <= 100)),
	CONSTRAINT "reading_statuses_rating_check" CHECK("__new_reading_statuses"."rating" IS NULL OR ("__new_reading_statuses"."rating" >= 1 AND "__new_reading_statuses"."rating" <= 5))
);
--> statement-breakpoint
INSERT INTO `__new_reading_statuses`("uri", "did", "bookUri", "status", "progress", "rating", "book_title", "book_author", "startedAt", "finishedAt", "createdAt") SELECT "uri", "did", "bookUri", "status", "progress", "rating", "book_title", "book_author", "startedAt", "finishedAt", "createdAt" FROM `reading_statuses`;--> statement-breakpoint
DROP TABLE `reading_statuses`;--> statement-breakpoint
ALTER TABLE `__new_reading_statuses` RENAME TO `reading_statuses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `reading_statuses_book_uri_idx` ON `reading_statuses` (`bookUri`);--> statement-breakpoint
CREATE INDEX `reading_statuses_did_idx` ON `reading_statuses` (`did`);--> statement-breakpoint
CREATE INDEX `reading_statuses_status_idx` ON `reading_statuses` (`status`);--> statement-breakpoint
CREATE TABLE `__new_reviews` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`bookUri` text NOT NULL,
	`text` text NOT NULL,
	`rating` real,
	`book_title` text NOT NULL,
	`book_author` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reviews_rating_check" CHECK("__new_reviews"."rating" IS NULL OR ("__new_reviews"."rating" >= 1 AND "__new_reviews"."rating" <= 5))
);
--> statement-breakpoint
INSERT INTO `__new_reviews`("uri", "did", "bookUri", "text", "rating", "book_title", "book_author", "createdAt") SELECT "uri", "did", "bookUri", "text", "rating", "book_title", "book_author", "createdAt" FROM `reviews`;--> statement-breakpoint
DROP TABLE `reviews`;--> statement-breakpoint
ALTER TABLE `__new_reviews` RENAME TO `reviews`;--> statement-breakpoint
CREATE INDEX `reviews_book_uri_idx` ON `reviews` (`bookUri`);--> statement-breakpoint
CREATE INDEX `reviews_did_idx` ON `reviews` (`did`);