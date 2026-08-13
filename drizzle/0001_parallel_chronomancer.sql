CREATE TABLE `review_blobs` (
	`pk` text PRIMARY KEY NOT NULL,
	`review_pk` text NOT NULL,
	`type` text NOT NULL,
	`cid` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`cache_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_pk`) REFERENCES `reviews`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_blobs_review_pk_idx` ON `review_blobs` (`review_pk`);--> statement-breakpoint
CREATE INDEX `review_blobs_type_idx` ON `review_blobs` (`type`);--> statement-breakpoint
CREATE INDEX `review_blobs_cid_idx` ON `review_blobs` (`cid`);--> statement-breakpoint
CREATE TABLE `review_tags` (
	`review_pk` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`review_pk`, `tag`),
	FOREIGN KEY (`review_pk`) REFERENCES `reviews`(`pk`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_tags_tag_idx` ON `review_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`pk` text PRIMARY KEY NOT NULL,
	`book_pk` text NOT NULL,
	`did` text NOT NULL,
	`rating` integer NOT NULL,
	`status` text NOT NULL,
	`text` text,
	`progress_format_pk` text,
	`progress_value` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`book_pk`) REFERENCES `books`(`pk`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`progress_format_pk`) REFERENCES `formats`(`pk`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reviews_rating_check" CHECK("reviews"."rating" >= 1 AND "reviews"."rating" <= 5),
	CONSTRAINT "reviews_status_check" CHECK("reviews"."status" IN ('reading', 'to-read', 'dnf', 'read'))
);
--> statement-breakpoint
CREATE INDEX `reviews_book_pk_idx` ON `reviews` (`book_pk`);--> statement-breakpoint
CREATE INDEX `reviews_did_idx` ON `reviews` (`did`);--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`);--> statement-breakpoint
CREATE INDEX `reviews_rating_idx` ON `reviews` (`rating`);--> statement-breakpoint
CREATE INDEX `reviews_progress_format_pk_idx` ON `reviews` (`progress_format_pk`);