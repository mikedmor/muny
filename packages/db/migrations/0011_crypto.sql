CREATE TABLE `crypto_prices` (
	`asset` text NOT NULL,
	`date` text NOT NULL,
	`usd` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`asset`, `date`)
);
--> statement-breakpoint
CREATE TABLE `crypto_txns` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`sent_asset` text,
	`sent_amount` text,
	`received_asset` text,
	`received_amount` text,
	`fee_asset` text,
	`fee_amount` text,
	`value_cents` integer,
	`fee_value_cents` integer,
	`imported_cost_basis_cents` integer,
	`imported_gain_cents` integer,
	`tx_hash` text,
	`description` text,
	`external_id` text NOT NULL,
	`source` text NOT NULL,
	`transfer_pair_id` text,
	`user_modified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `crypto_wallets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transfer_pair_id`) REFERENCES `crypto_txns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_txns_external_uq` ON `crypto_txns` (`wallet_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `crypto_txns_at_idx` ON `crypto_txns` (`at`);--> statement-breakpoint
CREATE TABLE `crypto_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`chain` text,
	`source_enc` text,
	`source_hint` text,
	`sync_enabled` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'never' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`sync_cursor` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
