CREATE TABLE `jetstream_cursor` (
	`name` text PRIMARY KEY NOT NULL,
	`cursor` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_records` (
	`did` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`cid` text NOT NULL,
	`record` text NOT NULL,
	`indexed_at` integer NOT NULL,
	PRIMARY KEY(`did`, `collection`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `user_records_collection_idx` ON `user_records` (`collection`);--> statement-breakpoint
CREATE INDEX `user_records_did_collection_idx` ON `user_records` (`did`,`collection`);