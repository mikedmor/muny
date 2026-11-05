CREATE TABLE `diy_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`service_name` text NOT NULL,
	`series_id` text,
	`alternative` text NOT NULL,
	`status` text DEFAULT 'idea' NOT NULL,
	`effort` text,
	`running_monthly_cents` integer DEFAULT 0 NOT NULL,
	`saving_id` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`saving_id`) REFERENCES `savings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `infra_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer,
	`period` text,
	`amortize_months` integer,
	`watts` integer,
	`price_deci_cents_per_kwh` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `savings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`series_id` text,
	`before_monthly_cents` integer NOT NULL,
	`after_monthly_cents` integer DEFAULT 0 NOT NULL,
	`effective_date` text NOT NULL,
	`status` text DEFAULT 'projected' NOT NULL,
	`status_note` text,
	`verified_at` integer,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE set null
);
