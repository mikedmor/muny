-- Coinbase calls Celo "CGLD" and Core "CORECHAIN"; everyone else (Koinly,
-- prices) says CELO and CORE. Rename what Coinbase sync stored so it matches
-- imports and Reconcile can pair the duplicates; the stored exchange balances
-- follow on the next sync.
UPDATE `crypto_txns` SET `received_asset` = 'CELO' WHERE `received_asset` = 'CGLD' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `sent_asset` = 'CELO' WHERE `sent_asset` = 'CGLD' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `fee_asset` = 'CELO' WHERE `fee_asset` = 'CGLD' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `received_asset` = 'CORE' WHERE `received_asset` = 'CORECHAIN' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `sent_asset` = 'CORE' WHERE `sent_asset` = 'CORECHAIN' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `fee_asset` = 'CORE' WHERE `fee_asset` = 'CORECHAIN' AND `external_id` LIKE 'coinbase:%';
