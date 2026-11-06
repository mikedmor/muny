CREATE TABLE `security_logos` (
	`symbol` text PRIMARY KEY NOT NULL,
	`content_type` text,
	`data` blob,
	`fetched_at` integer NOT NULL
);
