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
  /** Balances the blockchain reported at the last sync (null if never synced). */
  onChain: { asset: string; amount: string }[] | null;
  /** A sync is running right now. */
  syncing: boolean;
  /** Waiting its turn in a sync-all run. */
  queued: boolean;
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
  /** A price update is running right now. */
  pricesRefreshing: boolean;
  /** A wallet sync is running right now. */
  syncing: boolean;
  /** Newest successful wallet sync (null if no wallet syncs). */
  walletsSyncedAt: number | null;
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

/** Where prices come from. Both use CoinGecko coin ids for mapping. */
export type CryptoPriceProvider = "defillama" | "coingecko";

export interface CryptoSettings {
  /** Fetch prices (an opt-in outbound call: sends only coin ids). */
  pricesEnabled: boolean;
  provider: CryptoPriceProvider;
  /** Optional CoinGecko demo key for higher limits (write-only). */
  hasApiKey: boolean;
  /** Overrides: asset symbol → CoinGecko id. */
  assetIds: Record<string, string>;
  /** Server overrides per chain key (a Blockbook or Blockscout instance). */
  servers: Record<string, string>;
  /** Assets hidden everywhere (e.g. airdropped spam tokens). */
  hiddenAssets: string[];
  /** A Blockscout API key is saved (write-only). */
  hasBlockscoutKey: boolean;
}

/** Requests used against a free provider budget. */
export interface CryptoUsage {
  provider: string;
  label: string;
  today: number;
  dayLimit: number;
  month: number;
  monthLimit: number;
}

export interface CryptoSyncResult {
  added: number;
  duplicates: number;
}

/**
 * Coins Muny can sync, by what the user knows (the coin), not the provider.
 * The server picks the provider per chain and validates addresses; see
 * @muny/core CHAINS.
 */
export const CRYPTO_SYNC_CHAINS = [
  {
    key: "btc",
    name: "Bitcoin",
    coin: "BTC",
    placeholder: "zpub… / xpub… / bc1…",
    evm: false,
  },
  { key: "eth", name: "Ethereum", coin: "ETH", placeholder: "0x…", evm: true },
  {
    key: "ada",
    name: "Cardano",
    coin: "ADA",
    placeholder: "stake1… / addr1…",
    evm: false,
  },
  {
    key: "algo",
    name: "Algorand",
    coin: "ALGO",
    placeholder: "58-character address",
    evm: false,
  },
  { key: "xlm", name: "Stellar", coin: "XLM", placeholder: "G…", evm: false },
  { key: "atom", name: "Cosmos", coin: "ATOM", placeholder: "cosmos1…", evm: false },
  { key: "trx", name: "TRON", coin: "TRX", placeholder: "T…", evm: false },
  {
    key: "ltc",
    name: "Litecoin",
    coin: "LTC",
    placeholder: "Ltub… / ltc1… / L…",
    evm: false,
  },
  {
    key: "doge",
    name: "Dogecoin",
    coin: "DOGE",
    placeholder: "dgub… / D…",
    evm: false,
  },
  { key: "zec", name: "Zcash", coin: "ZEC", placeholder: "t1…", evm: false },
  { key: "polygon", name: "Polygon", coin: "POL", placeholder: "0x…", evm: true },
  { key: "base", name: "Base", coin: "ETH on Base", placeholder: "0x…", evm: true },
  {
    key: "arb",
    name: "Arbitrum",
    coin: "ETH on Arbitrum",
    placeholder: "0x…",
    evm: true,
  },
  {
    key: "op",
    name: "Optimism",
    coin: "ETH on Optimism",
    placeholder: "0x…",
    evm: true,
  },
  { key: "gnosis", name: "Gnosis", coin: "XDAI", placeholder: "0x…", evm: true },
] as const;

export type CryptoSyncChain = (typeof CRYPTO_SYNC_CHAINS)[number]["key"];

/**
 * Which coins an address (or extended public key) could belong to, from its
 * format. EVM addresses are shared by every EVM chain, so they return all of
 * them (Ethereum first). The server does the strict validation.
 */
export function detectCryptoChains(input: string): CryptoSyncChain[] {
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return ["eth", "polygon", "base", "arb", "op", "gnosis"];
  if (/^(stake1|addr1)[02-9ac-hj-np-z]{40,}$/.test(s)) return ["ada"];
  if (/^[A-Z2-7]{58}$/.test(s)) return ["algo"];
  if (/^G[A-Z2-7]{55}$/.test(s)) return ["xlm"];
  if (/^cosmos1[02-9ac-hj-np-z]{38}$/.test(s)) return ["atom"];
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return ["trx"];
  if (/^(ypub|zpub)/.test(s)) return ["btc", "ltc"];
  if (/^xpub/.test(s)) return ["btc", "ltc", "doge", "zec"];
  if (/^(Ltub|Mtub)/.test(s)) return ["ltc"];
  if (/^dgub/.test(s)) return ["doge"];
  if (/^bc1[02-9ac-hj-np-z]{11,71}$/i.test(s)) return ["btc"];
  if (/^ltc1[02-9ac-hj-np-z]{11,71}$/i.test(s)) return ["ltc"];
  if (/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return ["zec"];
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) return ["btc"];
  if (/^[LM][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) return ["ltc"];
  if (/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) return ["doge"];
  return [];
}

export interface CryptoTransferSuggestion {
  txnId: string;
  fromWalletId: string;
  fromWalletName: string;
  at: number;
  amount: string;
}

/** Why balances are off, per wallet, with what Muny can do about it. */
export interface CryptoReconcile {
  /** Several wallets syncing the same address (everything counted again). */
  sameAddress: {
    chain: string;
    chainName: string;
    wallets: { id: string; name: string; txnCount: number }[];
  }[];
  wallets: {
    walletId: string;
    walletName: string;
    kind: CryptoWalletKind;
    synced: boolean;
    /** More left than arrived: earlier deposits are missing. */
    missing: {
      asset: string;
      deficit: string;
      /** When the balance first went below zero. */
      firstAt: number;
      suggestions: CryptoTransferSuggestion[];
    }[];
    /** On-chain balance vs. what the transactions add up to. */
    mismatches: { asset: string; onChain: string; computed: string; diff: string }[];
    /** Synced transactions that repeat imported ones. */
    duplicates: number;
    /** Swap proceeds recorded here that arrived in another wallet. */
    crossChain: {
      txnId: string;
      asset: string;
      amount: string;
      at: number;
      toWalletId: string;
      toWalletName: string;
      toTxnId: string;
    }[];
  }[];
}
