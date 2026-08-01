ALTER TABLE `books` ADD `deduplication_hash` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `books_deduplication_hash_idx` ON `books` (`deduplication_hash`);
--> statement-breakpoint
ALTER TABLE `reviews` ADD `book_title` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `reviews` ADD `book_author` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `reading_statuses` ADD `book_title` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `reading_statuses` ADD `book_author` text NOT NULL DEFAULT '';
