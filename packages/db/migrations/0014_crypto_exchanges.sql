ALTER TABLE `crypto_wallets` ADD `exchange` text;--> statement-breakpoint
ALTER TABLE `crypto_wallets` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Recognize existing exchange wallets by name (Koinly's names).
UPDATE `crypto_wallets` SET `exchange` = CASE
    WHEN lower(`name`) LIKE '%coinbase pro%' OR lower(`name`) LIKE '%gdax%' THEN 'coinbase_pro'
    WHEN lower(`name`) LIKE '%coinbase%' THEN 'coinbase'
    WHEN lower(`name`) LIKE '%binance%us%' OR lower(`name`) LIKE '%binance.us%' THEN 'binance_us'
    WHEN lower(`name`) LIKE '%kraken%' THEN 'kraken'
    WHEN lower(`name`) LIKE '%gemini%' THEN 'gemini'
    WHEN lower(`name`) LIKE '%uphold%' THEN 'uphold'
    WHEN lower(`name`) LIKE '%bittrex%' THEN 'bittrex'
    WHEN lower(`name`) LIKE '%changelly%' THEN 'changelly'
    WHEN lower(`name`) LIKE '%tradeogre%' OR lower(`name`) LIKE '%trade ogre%' THEN 'tradeogre'
    ELSE NULL END
 WHERE `kind` = 'exchange' AND `exchange` IS NULL;
