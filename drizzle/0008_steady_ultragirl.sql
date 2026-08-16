CREATE TABLE `book_contributor_staging` (
	`edition_ol_key` text NOT NULL,
	`author_ol_key` text NOT NULL,
	`role_pk` text DEFAULT 'author' NOT NULL,
	PRIMARY KEY(`edition_ol_key`, `author_ol_key`, `role_pk`)
);
