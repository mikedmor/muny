ALTER TABLE `crypto_txns` ADD `counterparty` text;--> statement-breakpoint
-- Synced wallets already on the blockchain's version of their history (no
-- imported rows with a hash): a later Koinly import adds its tags and values
-- to the synced rows instead of bringing the imported rows back.
INSERT OR IGNORE INTO `app_settings` (`key`, `value`, `updated_at`)
SELECT 'crypto.chain_version', json_group_array(w.id), CAST(strftime('%s','now') AS integer) * 1000
  FROM `crypto_wallets` w
 WHERE w.source_enc IS NOT NULL
   AND EXISTS (SELECT 1 FROM `crypto_txns` s WHERE s.wallet_id = w.id AND s.source = 'sync' AND s.tx_hash IS NOT NULL AND s.tx_hash <> '')
   AND NOT EXISTS (SELECT 1 FROM `crypto_txns` i WHERE i.wallet_id = w.id AND i.source = 'import' AND i.tx_hash IS NOT NULL AND i.tx_hash <> '');
