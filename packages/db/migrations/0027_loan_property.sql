CREATE TABLE `asset_details` (
	`account_id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`purchase_price_cents` integer,
	`purchase_date` text,
	`address` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `loan_details` ADD `payment_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `loan_details` ADD `minimum_payment_cents` integer;--> statement-breakpoint
ALTER TABLE `loan_details` ADD `original_value_cents` integer;--> statement-breakpoint
ALTER TABLE `loan_details` ADD `pmi_monthly_cents` integer;--> statement-breakpoint
ALTER TABLE `loan_details` ADD `property_account_id` text REFERENCES accounts(id);