ALTER TABLE `card_details` ADD `payment_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `card_details` ADD `payment_day` integer;--> statement-breakpoint
ALTER TABLE `card_details` ADD `payment_from_account_id` text;--> statement-breakpoint
ALTER TABLE `lender_payments` ADD `from_account_id` text;--> statement-breakpoint
ALTER TABLE `loan_details` ADD `payment_from_account_id` text;