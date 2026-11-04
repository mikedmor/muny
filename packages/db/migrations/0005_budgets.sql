CREATE TABLE `budget_amounts` (
	`budget_id` text NOT NULL,
	`from_month` text NOT NULL,
	`amount_cents` integer NOT NULL,
	PRIMARY KEY(`budget_id`, `from_month`),
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`rollover` integer DEFAULT false NOT NULL,
	`start_month` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_category_uq` ON `budgets` (`category_id`) WHERE "budgets"."category_id" IS NOT NULL;