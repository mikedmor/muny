CREATE TABLE `stock_tax_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`year` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`format` text NOT NULL,
	`size` integer NOT NULL,
	`data` blob NOT NULL,
	`sales` text DEFAULT '[]' NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	`summary_source` text,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stock_tax_docs_year` ON `stock_tax_docs` (`year`,`account_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `subtype` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `tax_treatment` text;