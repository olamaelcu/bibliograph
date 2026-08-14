CREATE TABLE `book_shelves` (
	`pk` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`book_pk` text NOT NULL,
	`shelf_pk` text NOT NULL,
	`position` integer,
	`notes` text,
	`emoji` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`book_pk`) REFERENCES `books`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shelf_pk`) REFERENCES `shelves`(`pk`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "book_shelves_position_check" CHECK("book_shelves"."position" IS NULL OR "book_shelves"."position" >= 1),
	CONSTRAINT "book_shelves_status_check" CHECK("book_shelves"."status" IN ('reading', 'to-read', 'dnf', 'read'))
);
--> statement-breakpoint
CREATE INDEX `book_shelves_did_idx` ON `book_shelves` (`did`);--> statement-breakpoint
CREATE INDEX `book_shelves_book_pk_idx` ON `book_shelves` (`book_pk`);--> statement-breakpoint
CREATE INDEX `book_shelves_shelf_pk_idx` ON `book_shelves` (`shelf_pk`);--> statement-breakpoint
CREATE INDEX `book_shelves_status_idx` ON `book_shelves` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `book_shelves_unique_idx` ON `book_shelves` (`book_pk`,`shelf_pk`);