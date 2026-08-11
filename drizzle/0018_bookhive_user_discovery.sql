CREATE TABLE `bookhive_user_discovery` (
	`did` text PRIMARY KEY NOT NULL,
	`handle` text,
	`first_seen_activity_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`book_count_discovered` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
