CREATE TABLE `crypto_tax_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`year` integer NOT NULL,
	`kind` text DEFAULT '1099-DA' NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`basis_reported` integer DEFAULT true NOT NULL,
	`data` blob NOT NULL,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `crypto_wallets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `crypto_tax_docs_year` ON `crypto_tax_docs` (`year`,`wallet_id`);