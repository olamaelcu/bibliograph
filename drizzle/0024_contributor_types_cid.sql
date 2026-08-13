ALTER TABLE `contributor_types` ADD COLUMN `cid` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contributor_types_cid_idx` ON `contributor_types` (`cid`);