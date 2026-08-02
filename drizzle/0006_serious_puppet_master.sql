CREATE TABLE `label_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`src` text NOT NULL,
	`uri` text NOT NULL,
	`val` text NOT NULL,
	`neg` integer DEFAULT 0 NOT NULL,
	`cts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_events_uri_idx` ON `label_events` (`uri`);