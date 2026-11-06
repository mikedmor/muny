CREATE TABLE `account_alerts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`low_balance_cents` integer,
	`large_charge_cents` integer,
	`unusual_charge` integer DEFAULT true NOT NULL,
	`duplicate_charge` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
