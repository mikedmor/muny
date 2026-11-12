CREATE TABLE `price_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`symbol` text NOT NULL,
	`condition` text NOT NULL,
	`value` text,
	`base_price` text,
	`note` text,
	`repeat` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` integer,
	`last_fired_price` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
