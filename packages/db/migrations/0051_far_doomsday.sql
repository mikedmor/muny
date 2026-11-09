CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`changeset_id` text NOT NULL,
	`tbl` text NOT NULL,
	`op` text NOT NULL,
	`pk` text NOT NULL,
	`old_row` text,
	`new_row` text
);
--> statement-breakpoint
CREATE INDEX `change_log_changeset_idx` ON `change_log` (`changeset_id`);--> statement-breakpoint
CREATE TABLE `changesets` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`label` text,
	`route` text,
	`undone_by` text,
	`undo_of` text
);
--> statement-breakpoint
CREATE INDEX `changesets_at_idx` ON `changesets` (`at`);