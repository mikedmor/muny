CREATE TABLE `watchlist` (
	`security_id` text PRIMARY KEY NOT NULL,
	`added_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
