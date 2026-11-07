CREATE TABLE `agent_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text,
	`token_name` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`summary` text NOT NULL,
	`reason` text,
	`changes` text NOT NULL,
	`warnings` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_proposals_status_idx` ON `agent_proposals` (`status`,`created_at`);