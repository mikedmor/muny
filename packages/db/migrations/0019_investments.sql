CREATE TABLE `investment_holdings` (
	`account_id` text NOT NULL,
	`security_id` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text,
	`value_cents` integer NOT NULL,
	`cost_basis_cents` integer,
	`as_of` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`account_id`, `security_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `investment_txns` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`security_id` text,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`quantity` text,
	`price` text,
	`amount_cents` integer NOT NULL,
	`fees_cents` integer DEFAULT 0 NOT NULL,
	`description` text,
	`external_id` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_txns_external_uq` ON `investment_txns` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `investment_txns_date_idx` ON `investment_txns` (`date`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`plaid_security_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_symbol_uq` ON `securities` (`symbol`);--> statement-breakpoint
CREATE TABLE `security_prices` (
	`security_id` text NOT NULL,
	`date` text NOT NULL,
	`close` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`security_id`, `date`),
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
