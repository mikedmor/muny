-- Binance US answered history requests spanning years with only part of the
-- range, so older deposits, withdrawals and distributions were missed. Read
-- Binance US again from the start (now in 90-day windows); rows are keyed, so
-- nothing already stored doubles.
UPDATE `crypto_wallets` SET `sync_cursor` = NULL, `last_sync_at` = NULL
 WHERE `exchange` = 'binance_us' AND `source_enc` IS NOT NULL;
