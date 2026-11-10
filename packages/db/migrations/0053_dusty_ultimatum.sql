CREATE TABLE `document_reviews` (
	`document_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`steps_done` integer DEFAULT 0 NOT NULL,
	`steps_total` integer DEFAULT 0 NOT NULL,
	`waiting` text,
	`error` text,
	`encrypted` integer DEFAULT false NOT NULL,
	`result` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
