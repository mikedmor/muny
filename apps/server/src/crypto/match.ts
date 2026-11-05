import { type SQL, sql } from "drizzle-orm";

/**
 * Matching the same movement recorded twice (an imported row and its synced
 * copy). Exports differ in small ways: Koinly drops the "0x" from Ethereum
 * hashes and rounds amounts (Coinbase rewards to 6 decimals), so hashes are
 * compared without "0x" or case, and amounts within 0.1% or 0.000001. This only decides "same transaction?"; it never feeds
 * a stored amount (the money path stays exact).
 */

/** SQL expression: a tx_hash column, lowercased, without "0x". */
export const normHashSql = (col: string): SQL =>
  sql.raw(`lower(case when ${col} like '0x%' then substr(${col}, 3) else ${col} end)`);

/** A hash value normalised the same way. */
export const normHash = (h: string) => h.toLowerCase().replace(/^0x/, "");

/** SQL condition: two decimal-text amount columns within 0.1% (or 0.000001, rounding) of each other. */
export const closeAmountsSql = (a: string, b: string): SQL =>
  sql.raw(
    `(${a} is not null and ${b} is not null and abs(cast(${a} as real) - cast(${b} as real)) <= max(0.001 * abs(cast(${b} as real)), ${ROUNDING}) + 1e-12)`,
  );

/**
 * Differences smaller than this (in coins) are rounding between exports and
 * exchanges, not missing history: never worth a warning.
 */
export const ROUNDING = 0.000001;
export const ROUNDING_TEXT = "0.000001";
