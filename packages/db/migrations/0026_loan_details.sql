CREATE TABLE `loan_details` (
	`account_id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`lender` text,
	`apr_bps` integer,
	`monthly_payment_cents` integer,
	`next_due_date` text,
	`original_principal_cents` integer,
	`origination_date` text,
	`term_months` integer,
	`start_balance_cents` integer,
	`start_date` text,
	`payment_match` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
