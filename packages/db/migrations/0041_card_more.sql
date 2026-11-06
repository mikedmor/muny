ALTER TABLE `card_details` ADD `payment_match` text;--> statement-breakpoint
ALTER TABLE `card_details` ADD `interest_ytd_cents` integer;--> statement-breakpoint
ALTER TABLE `card_details` ADD `interest_ytd_year` integer;--> statement-breakpoint
ALTER TABLE `card_details` ADD `min_only_months` integer;--> statement-breakpoint
ALTER TABLE `card_details` ADD `min_only_total_cents` integer;