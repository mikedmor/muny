CREATE TABLE `lender_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`lender_key` text NOT NULL,
	`payment_match` text,
	`due_day` integer,
	`parts` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
