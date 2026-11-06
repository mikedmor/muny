CREATE TABLE `card_details` (
	`account_id` text PRIMARY KEY NOT NULL,
	`issuer` text,
	`credit_limit_cents` integer,
	`apr_bps` integer,
	`statement_balance_cents` integer,
	`statement_date` text,
	`minimum_payment_cents` integer,
	`due_date` text,
	`last_payment_cents` integer,
	`last_payment_date` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
