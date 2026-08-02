CREATE TABLE `shelf_items` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`shelfUri` text NOT NULL,
	`bookUri` text NOT NULL,
	`book_title` text NOT NULL,
	`book_author` text NOT NULL,
	`note` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`shelfUri`) REFERENCES `shelves`(`uri`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shelf_items_shelf_uri_idx` ON `shelf_items` (`shelfUri`);--> statement-breakpoint
CREATE INDEX `shelf_items_book_uri_idx` ON `shelf_items` (`bookUri`);--> statement-breakpoint
CREATE INDEX `shelf_items_did_idx` ON `shelf_items` (`did`);--> statement-breakpoint
CREATE UNIQUE INDEX `shelf_items_shelf_book_unique` ON `shelf_items` (`shelfUri`,`bookUri`);--> statement-breakpoint
CREATE TABLE `shelves` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`metadata` text DEFAULT '{}',
	`coverUrl` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shelves_did_idx` ON `shelves` (`did`);--> statement-breakpoint
CREATE INDEX `shelves_name_idx` ON `shelves` (`name`);