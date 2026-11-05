CREATE TABLE `crypto_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`status` text NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`message` text,
	FOREIGN KEY (`wallet_id`) REFERENCES `crypto_wallets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `crypto_sync_runs_wallet` ON `crypto_sync_runs` (`wallet_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `crypto_wallets` ADD `notes` text;