DELETE FROM `reading_statuses` WHERE `uri` NOT IN (
	SELECT `uri` FROM (
		SELECT `uri`,
			ROW_NUMBER() OVER (PARTITION BY `did`, `bookUri` ORDER BY `createdAt` DESC) AS `rn`
		FROM `reading_statuses`
	) WHERE `rn` = 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `reading_statuses_did_book_uri_unique` ON `reading_statuses` (`did`,`bookUri`);