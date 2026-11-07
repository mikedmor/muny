ALTER TABLE `categories` ADD `is_home` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `categories` SET `is_home` = 1, `is_bill` = 0 WHERE `name` IN ('Rent & Mortgage', 'Electric', 'Gas & Heating', 'Water & Sewer', 'Trash', 'Internet', 'Phone') AND `group_id` IN (SELECT `id` FROM `category_groups` WHERE `kind` = 'expense');
