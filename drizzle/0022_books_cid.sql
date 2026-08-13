ALTER TABLE `books` ADD COLUMN `cid` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `books_cid_idx` ON `books` (`cid`);