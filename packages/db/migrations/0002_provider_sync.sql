ALTER TABLE `connections` ADD `sync_cursor` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `ignored_account_refs` text DEFAULT '[]' NOT NULL;