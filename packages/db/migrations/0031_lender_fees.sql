CREATE TABLE `lender_fees` (
	`lender_key` text PRIMARY KEY NOT NULL,
	`lender` text NOT NULL,
	`payment_match` text,
	`min_cents` integer NOT NULL,
	`next_due_date` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `lender_fees` (`lender_key`, `lender`, `payment_match`, `min_cents`)
SELECT lower(trim(coalesce(ld.`lender`, a.`institution_name`))), trim(coalesce(ld.`lender`, a.`institution_name`)), ld.`payment_match`, min(ld.`fee_min_cents`)
FROM `loan_details` ld JOIN `accounts` a ON a.`id` = ld.`account_id`
WHERE ld.`fee_min_cents` IS NOT NULL AND coalesce(ld.`lender`, a.`institution_name`) IS NOT NULL
GROUP BY lower(trim(coalesce(ld.`lender`, a.`institution_name`)));
--> statement-breakpoint
ALTER TABLE `loan_details` DROP COLUMN `fee_min_cents`;