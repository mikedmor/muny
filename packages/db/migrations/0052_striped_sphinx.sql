CREATE TABLE `ai_reviews` (
	`month` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
-- Reviews written before this table, from their notifications.
INSERT OR IGNORE INTO `ai_reviews` (`month`, `body`, `created_at`) SELECT substr(`dedupe_key`, 11), `body`, `created_at` FROM `notifications` WHERE `rule_type` = 'ai_review' AND `dedupe_key` LIKE 'ai_review:____-__';
