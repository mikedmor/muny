CREATE TABLE `pay_stubs` (
	`id` text PRIMARY KEY NOT NULL,
	`employer` text,
	`pay_date` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`gross_cents` integer NOT NULL,
	`net_cents` integer NOT NULL,
	`ytd_gross_cents` integer,
	`federal_taxable_cents` integer,
	`lines` text DEFAULT '[]' NOT NULL,
	`deposits` text DEFAULT '[]' NOT NULL,
	`check_cents` integer DEFAULT 0 NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`data` blob NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pay_stubs_date` ON `pay_stubs` (`pay_date`);--> statement-breakpoint
CREATE TABLE `w2_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`employer` text,
	`boxes` text NOT NULL,
	`box12` text DEFAULT '[]' NOT NULL,
	`summary` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`data` blob NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `w2_forms_year` ON `w2_forms` (`year`);