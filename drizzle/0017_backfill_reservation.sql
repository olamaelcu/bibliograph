-- Reservation row coordinating dump backfills against live writes.
-- A single row per state name: the importer refreshes `heartbeat_at` on every
-- batch boundary; the web app observes the row to know a backfill is active.
CREATE TABLE IF NOT EXISTS `backfill_reservation` (
	`state_name` text PRIMARY KEY NOT NULL,
	`owner_pid` integer NOT NULL,
	`acquired_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`batch_size` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
