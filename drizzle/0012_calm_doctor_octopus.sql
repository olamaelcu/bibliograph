CREATE TABLE `book_contributors` (
	`bookUri` text NOT NULL,
	`contributorUri` text NOT NULL,
	`contributorCid` text NOT NULL,
	`roleUri` text NOT NULL,
	`roleCid` text NOT NULL,
	`ordering` integer DEFAULT 0,
	PRIMARY KEY(`bookUri`, `contributorUri`, `roleUri`),
	FOREIGN KEY (`bookUri`) REFERENCES `books`(`uri`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_contributors_book_idx` ON `book_contributors` (`bookUri`);--> statement-breakpoint
CREATE INDEX `book_contributors_contributor_idx` ON `book_contributors` (`contributorUri`);--> statement-breakpoint
CREATE INDEX `book_contributors_role_idx` ON `book_contributors` (`roleUri`);--> statement-breakpoint
CREATE TABLE `contributor_types` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contributor_types_name_unique` ON `contributor_types` (`name`);--> statement-breakpoint
CREATE INDEX `contributor_types_did_idx` ON `contributor_types` (`did`);--> statement-breakpoint
CREATE INDEX `contributor_types_name_idx` ON `contributor_types` (`name`);--> statement-breakpoint
CREATE TABLE `contributors` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`name` text NOT NULL,
	`altNames` text DEFAULT '[]',
	`images` text DEFAULT '[]',
	`identifiers` text DEFAULT '[]',
	`bio` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contributors_name_idx` ON `contributors` (`name`);--> statement-breakpoint
CREATE INDEX `contributors_did_idx` ON `contributors` (`did`);--> statement-breakpoint
CREATE INDEX `contributors_created_at_idx` ON `contributors` (`createdAt`);