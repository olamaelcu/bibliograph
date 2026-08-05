CREATE TABLE `backfill_state` (
	`name` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`file_path` text NOT NULL,
	`last_modified` text,
	`file_size` integer,
	`last_byte_offset` integer DEFAULT 0 NOT NULL,
	`last_key_cursor` text,
	`total_processed` integer DEFAULT 0 NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL
);
