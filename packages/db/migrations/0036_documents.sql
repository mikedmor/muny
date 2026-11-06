CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`lender` text,
	`document_date` text,
	`notes` text,
	`encrypted` integer DEFAULT false NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_sha256_uq` ON `documents` (`sha256`);--> statement-breakpoint
ALTER TABLE `loan_statement_payments` ADD `balance_cents` integer;