-- Coinbase's first sync recorded each Advanced Trade fill separately and
-- missed imported rows that Koinly had rounded, so it duplicated them. Remove
-- what it synced and read Coinbase again with the corrected matching.
DELETE FROM `crypto_txns`
 WHERE `source` = 'sync' AND `external_id` LIKE 'coinbase:%';
--> statement-breakpoint
UPDATE `crypto_txns` SET `type` = CASE WHEN `sent_asset` IS NULL THEN 'deposit' ELSE 'withdrawal' END
 WHERE `type` = 'transfer' AND `transfer_pair_id` IS NULL;
--> statement-breakpoint
UPDATE `crypto_wallets` SET `sync_cursor` = NULL, `last_sync_at` = NULL
 WHERE `exchange` = 'coinbase' AND `source_enc` IS NOT NULL;
