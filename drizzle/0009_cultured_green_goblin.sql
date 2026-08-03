CREATE TABLE `features` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `books_created_at_idx` ON `books` (`createdAt`);--> statement-breakpoint
CREATE INDEX `reading_statuses_created_at_idx` ON `reading_statuses` (`createdAt`);--> statement-breakpoint
CREATE INDEX `reading_statuses_did_created_at_idx` ON `reading_statuses` (`did`,`createdAt`);--> statement-breakpoint
CREATE INDEX `reading_statuses_book_uri_created_at_idx` ON `reading_statuses` (`bookUri`,`createdAt`);--> statement-breakpoint
CREATE INDEX `reviews_created_at_idx` ON `reviews` (`createdAt`);--> statement-breakpoint
CREATE INDEX `reviews_did_created_at_idx` ON `reviews` (`did`,`createdAt`);--> statement-breakpoint
CREATE INDEX `reviews_book_uri_created_at_idx` ON `reviews` (`bookUri`,`createdAt`);