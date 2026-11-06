CREATE TABLE `loan_statement_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`statement_date` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`interest_cents` integer NOT NULL,
	`principal_cents` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_statement_payments_uq` ON `loan_statement_payments` (`account_id`,`statement_date`);