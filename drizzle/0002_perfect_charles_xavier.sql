ALTER TABLE `contributors` ADD `cid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `cid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contributor_roles` ADD `cid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `formats` ADD `cid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `genres` ADD `cid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `works` ADD `cid` text DEFAULT '' NOT NULL;