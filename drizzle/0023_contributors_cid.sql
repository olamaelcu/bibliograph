ALTER TABLE `contributors` ADD COLUMN `cid` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contributors_cid_idx` ON `contributors` (`cid`);