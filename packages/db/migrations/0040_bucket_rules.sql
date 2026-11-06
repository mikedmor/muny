ALTER TABLE `savings_buckets` ADD `monthly_cap_cents` integer;--> statement-breakpoint
ALTER TABLE `savings_buckets` ADD `fill_remaining` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `savings_buckets` ADD `is_main` integer DEFAULT false NOT NULL;