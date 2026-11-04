CREATE TABLE `recurring_series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`match_key` text NOT NULL,
	`direction` text NOT NULL,
	`anchor_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`interval` text NOT NULL,
	`expected_amount_cents` integer NOT NULL,
	`fixed_amount` integer DEFAULT true NOT NULL,
	`first_date` text NOT NULL,
	`last_date` text NOT NULL,
	`last_amount_cents` integer NOT NULL,
	`account_id` text,
	`payee_id` text,
	`category_id` text,
	`source` text DEFAULT 'detected' NOT NULL,
	`user_modified` integer DEFAULT false NOT NULL,
	`cancelled_at` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_series_key_idx` ON `recurring_series` (`match_key`,`direction`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurring_series_id` text REFERENCES recurring_series(id) ON DELETE set null;