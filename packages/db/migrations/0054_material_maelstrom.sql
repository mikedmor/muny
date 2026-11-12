CREATE TABLE `mail_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_key` text NOT NULL,
	`received_at` integer NOT NULL,
	`from_address` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`signed` text DEFAULT 'none' NOT NULL,
	`body_enc` text,
	`account_id` text,
	`transaction_id` text,
	`document_id` text,
	`template_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `mail_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_key_uq` ON `mail_messages` (`message_key`);--> statement-breakpoint
CREATE TABLE `mail_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`from_match` text NOT NULL,
	`subject_match` text,
	`direction` text DEFAULT 'out' NOT NULL,
	`account_id` text,
	`fields` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
