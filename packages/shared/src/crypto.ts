/**
 * Crypto portfolio DTOs. Quantities are exact decimal strings (never floats);
 * USD values are integer cents.
 */

export type CryptoWalletKind = "blockchain" | "exchange" | "manual";
export type CryptoTxnType = "deposit" | "withdrawal" | "trade" | "transfer";

/** Labels that change how a transaction is treated for tax (Koinly-compatible). */
export const CRYPTO_LABELS = [
  "reward",
  "staking",
  "airdrop",
  "mining",
  "income",
  "gift",
  "donation",
  "lost",
  "cost",
  "fee_refund",
] as const;

export interface CryptoBalance {
  asset: string;
  amount: string;
  /** Current value, when a price is known. */
  valueCents: number | null;
}

export interface CryptoWallet {
  id: string;
  name: string;
  kind: CryptoWalletKind;
  chain: string | null;
  /** Safe hint of the synced address/xpub, e.g. "zpub6s…D8SH5". */
  sourceHint: string | null;
  syncEnabled: boolean;
  status: "ok" | "error" | "never";
  lastSyncAt: number | null;
  lastError: string | null;
  txnCount: number;
  lastTxnAt: number | null;
  balances: CryptoBalance[];
  valueCents: number;
}

export interface CryptoTxn {
  id: string;
  walletId: string;
  walletName: string;
  at: number;
  type: CryptoTxnType;
  label: string | null;
  sentAsset: string | null;
  sentAmount: string | null;
  receivedAsset: string | null;
  receivedAmount: string | null;
  feeAsset: string | null;
  feeAmount: string | null;
  valueCents: number | null;
  feeValueCents: number | null;
  txHash: string | null;
  description: string | null;
  source: "sync" | "import" | "manual";
  /** The other side of a transfer between your own wallets. */
  transferPairId: string | null;
  transferWalletName: string | null;
}

export interface CryptoTxnPage {
  items: CryptoTxn[];
  total: number;
  offset: number;
  limit: number;
}

export interface CryptoTxnQuery {
  walletId?: string;
  asset?: string;
  type?: CryptoTxnType;
  label?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export interface CryptoHolding {
  asset: string;
  /** Display name, e.g. "Ethereum" (the symbol when unknown). */
  name: string;
  amount: string;
  /** USD per unit now (decimal string) and value, when a price is known. */
  price: string | null;
  valueCents: number | null;
  change24hPct: number | null;
  /** Share of the portfolio value (0-100). */
  allocationPct: number;
  wallets: { walletId: string; walletName: string; amount: string }[];
}

export interface CryptoOverview {
  totalValueCents: number;
  /** Assets without a known price (value not counted). */
  unpricedAssets: string[];
  /**
   * Assets that go negative somewhere: more left a wallet than arrived, so
   * earlier history is missing (Koinly calls this "missing purchase history").
   */
  missingHistory: { asset: string; walletName: string; amount: string }[];
  holdings: CryptoHolding[];
  /** Portfolio value per day (oldest first), from stored daily prices. */
  history: { date: string; valueCents: number }[];
  pricesEnabled: boolean;
  pricesUpdatedAt: number | null;
  walletCount: number;
  txnCount: number;
}

export interface CryptoImportPreview {
  txns: number;
  duplicates: number;
  errors: { line: number; message: string }[];
  /** Wallets in the file and whether they already exist in Muny. */
  wallets: { name: string; kind: CryptoWalletKind; exists: boolean; txns: number }[];
  from: number | null;
  to: number | null;
}

export interface CryptoImportResult {
  imported: number;
  duplicates: number;
  walletsCreated: number;
  errors: { line: number; message: string }[];
}

export interface CryptoSettings {
  /** Fetch prices from CoinGecko (an opt-in outbound call: sends only coin ids). */
  pricesEnabled: boolean;
  /** Optional CoinGecko demo/pro key for higher limits (write-only). */
  hasApiKey: boolean;
  /** Overrides: asset symbol → CoinGecko id. */
  assetIds: Record<string, string>;
}
