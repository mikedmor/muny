ALTER TABLE `accounts` ADD `balance_source` text DEFAULT 'computed' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `opening_balance_cents` integer DEFAULT 0 NOT NULL;