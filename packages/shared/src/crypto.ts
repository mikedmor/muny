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
  /** Coins you hid (e.g. spam tokens) that this wallet holds. */
  hiddenBalances: { asset: string; amount: string }[];
  /** A sync is running right now. */
  syncing: boolean;
  /** Waiting its turn in a sync-all run. */
  queued: boolean;
  createdAt: number;
  notes: string | null;
  /** Which exchange (catalog key in CRYPTO_EXCHANGES), when it is one. */
  exchange: string | null;
  /** Kept for history but out of the way. */
  archived: boolean;
}

/** One sync attempt (the wallet page's history). */
export interface CryptoSyncRun {
  id: string;
  startedAt: number;
  finishedAt: number;
  status: "ok" | "error";
  added: number;
  duplicates: number;
  message: string | null;
}

/** A wallet with its transaction counts by type (the wallet page). */
export interface CryptoWalletDetail extends CryptoWallet {
  counts: { total: number } & Record<CryptoTxnType, number>;
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
  walletChain: string | null;
  walletKind: CryptoWalletKind;
  /** The other side of a transfer: its wallet and what it sent/received. */
  transfer: {
    walletId: string;
    walletName: string;
    walletChain: string | null;
    walletKind: CryptoWalletKind;
    asset: string | null;
    amount: string | null;
    feeAsset: string | null;
    feeAmount: string | null;
    valueCents: number | null;
  } | null;
  /** The other address: who sent a deposit, or where a withdrawal went. */
  counterparty: string | null;
  /**
   * More left the wallet than it had (purchase history is missing, which
   * tax reports need): per coin, how much.
   */
  missingHistory: { asset: string; amount: string }[];
  /**
   * Looks like another row recorded twice: the same coin and total leaving
   * (or arriving in) the same wallet within minutes, with no conflicting hashes.
   */
  possibleDuplicate: {
    id: string;
    at: number;
    walletName: string;
    otherWallet: string | null;
  } | null;
  /** Whether it can be deleted (imported or added by hand; synced rows come back). */
  deletable: boolean;
  /** Imported cost basis / gain (Koinly), when known. */
  importedCostBasisCents: number | null;
  importedGainCents: number | null;
}

export interface CryptoTxnPage {
  items: CryptoTxn[];
  total: number;
  offset: number;
  limit: number;
}

export interface CryptoTxnQuery {
  /** One wallet id, or several separated by commas. */
  walletId?: string;
  /** Only transactions with this warning. */
  warnings?: "missing" | "duplicates";
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
  /** What the coins you hold cost (FIFO across wallets), in cents; null when unknown. */
  costCents: number | null;
  /** Part of the cost is unknown (missing history or prices). */
  costIncomplete: boolean;
  /** Market cap in USD (display only), when the price provider reports it. */
  marketCapUsd: number | null;
  /** Daily closes for the last 30 days, oldest first (display only). */
  spark: number[];
  /**
   * Every wallet that holds or has held this coin (emptied ones show 0), most
   * first. Value is null without a price.
   */
  wallets: {
    walletId: string;
    walletName: string;
    walletKind: CryptoWalletKind;
    chain: string | null;
    amount: string;
    valueCents: number | null;
  }[];
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
  /** Value and cost basis (FIFO, what you paid for what you held) per day. */
  history: { date: string; valueCents: number; costCents: number }[];
  /** Each of the largest holdings' value per history point, then "Other"; they add up to the value. */
  historyByAsset: { asset: string; values: number[] }[];
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
  wallets: {
    name: string;
    kind: CryptoWalletKind;
    exists: boolean;
    txns: number;
    /** The Muny wallet this most likely is ("ETH Exodus" ↔ "Exodus ETH"), if any. */
    suggestedWalletId: string | null;
    /** Koinly rows already imported into that wallet (replaced when replacing). */
    alreadyImported: number;
  }[];
  from: number | null;
  to: number | null;
  /** Koinly's full export (every year, stable IDs). */
  full: boolean;
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
  /** Which coins count as sold first (cost basis, gains): Koinly lets you pick too. */
  costMethod: "fifo" | "lifo" | "hifo";
  /**
   * "us": one pool across wallets until 2025, then per wallet (IRS Rev. Proc.
   * 2024-28); "universal": one pool throughout.
   */
  costScope: "us" | "universal";
  /** Load NFT images (through this server, so their hosts don't see you). */
  nftImages: boolean;
  /** Reconcile items you chose to ignore (they also leave the dashboard). */
  ignored: string[];
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
  {
    key: "sc",
    name: "Siacoin",
    coin: "SC",
    placeholder: "76-character address (several: separate with commas)",
    evm: false,
  },
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
  if (/^[0-9a-fA-F]{76}([\s,;]+[0-9a-fA-F]{76})*$/.test(s)) return ["sc"];
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
/** When US cost tracking turns per wallet (IRS Rev. Proc. 2024-28). */
export const US_PER_WALLET_FROM = Date.UTC(2025, 0, 1);

/** The key that ignores one Reconcile item, until its amount changes. */
export const reconcileKey = (
  kind: "missing" | "mismatch",
  walletId: string,
  asset: string,
  amount: string,
) => `${kind}:${walletId}:${asset}:${amount}`;

export interface CryptoReconcile {
  /** Items you chose to ignore (Reconcile can list them again). */
  ignored: {
    key: string;
    walletName: string;
    asset: string;
    kind: "missing" | "mismatch";
    amount: string;
  }[];
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
    chain: string | null;
    synced: boolean;
    /** More left than arrived: earlier deposits are missing. */
    missing: {
      /** Ignore key (stays ignored until the amount changes). */
      key: string;
      asset: string;
      deficit: string;
      /** When the balance first went below zero. */
      firstAt: number;
      /** Earlier Reconcile fixes sending this coin out, whose basis is gone (undo them). */
      staleFixes: string[];
      suggestions: CryptoTransferSuggestion[];
    }[];
    /** On-chain balance vs. what the transactions add up to. */
    mismatches: {
      /** Ignore key (stays ignored until the difference changes). */
      key: string;
      asset: string;
      onChain: string;
      computed: string;
      diff: string;
      /**
       * When Muny has more: deposits that add up to exactly the difference
       * (most likely counted twice). Empty when none do.
       */
      extra: { txnId: string; at: number; amount: string; source: string; label: string | null }[];
      /** The wallet earns staking rewards (so a shortfall may be rewards). */
      staking: boolean;
      /**
       * Synced staking rewards add up to exactly the difference: the import
       * already has them (Koinly records rewards when withdrawn).
       */
      rewardsTwice: { synced: number; chain: string | null } | null;
      /**
       * The chain no longer has the account (e.g. a closed Stellar account)
       * while the history still holds coins: the move that emptied it is
       * missing. Deposits elsewhere that may be where they went.
       */
      closed: {
        lastAt: number;
        suggestions: CryptoTransferSuggestion[];
      } | null;
      /** When this coin last moved in the wallet (a sensible date for an adjustment). */
      lastActivityAt: number | null;
      /** Earlier Reconcile fixes in this wallet that moved this coin (undo them if wrong). */
      fixes: { txnId: string; at: number; amount: string; description: string }[];
    }[];
    /** Synced transactions that repeat imported ones. */
    duplicates: number;
    /** Imported rows with a transaction hash (a synced wallet can use the chain's version). */
    importedWithHash: number;
    /**
     * Siacoin: synced sends the import doesn't have. Moving coins between the
     * wallet's own addresses looks the same as paying someone, so you say which.
     */
    siaSends: { txnId: string; at: number; amount: string }[];
    /** Swap proceeds recorded here that arrived in another wallet. */
    crossChain: {
      txnId: string;
      asset: string;
      amount: string;
      at: number;
      toWalletId: string;
      toWalletName: string;
      /** The synced deposit there, or null when Muny should record one. */
      toTxnId: string | null;
    }[];
  }[];
}

/**
 * Exchanges Muny knows: whether they still run, whether Muny can sync them
 * (read-only API key), and how to set that up. Closed ones keep their history
 * from imports; archive them once nothing is left (or mark what's left lost).
 */
export interface CryptoExchangeInfo {
  key: string;
  name: string;
  status: "active" | "closed";
  /** "api": Muny syncs it with a read-only key; "import": history from files only. */
  sync: "api" | "import";
  /** Roughly when it stopped serving customers (closed ones), YYYY-MM-DD. */
  closedOn?: string;
  /** What to know (why it can't sync, what happened to it). */
  note: string;
  /** For "api": the fields to paste and how to make a read-only key. */
  setup?: {
    keyLabel: string;
    secretLabel: string;
    passphrase?: string;
    steps: string;
    url: string;
  };
}

export const CRYPTO_EXCHANGES: CryptoExchangeInfo[] = [
  {
    key: "coinbase",
    name: "Coinbase",
    status: "active",
    sync: "api",
    note: "Syncs buys, sells, Advanced Trade fills, sends and receives, and rewards for every coin in your account.",
    setup: {
      keyLabel: "API key name (organizations/…/apiKeys/…)",
      secretLabel: "Private key (-----BEGIN EC PRIVATE KEY----- …)",
      steps:
        "In the Coinbase Developer Platform, create a Secret API key: give it the View permission only, and under Advanced settings choose the ECDSA signature algorithm (Coinbase's account API doesn't accept Ed25519 keys). Paste the key name and the private key.",
      url: "https://portal.cdp.coinbase.com/projects/api-keys",
    },
  },
  {
    key: "coinbase_pro",
    name: "Coinbase Pro",
    status: "closed",
    sync: "import",
    closedOn: "2023-01-01",
    note: "Coinbase retired Coinbase Pro; its balances moved into Coinbase (Advanced Trade), so syncing Coinbase covers what came after. Older Pro history comes from your import. Archive this wallet once it holds nothing.",
  },
  {
    key: "kraken",
    name: "Kraken",
    status: "active",
    sync: "api",
    note: "Syncs Kraken's ledger: trades, deposits, withdrawals, staking and earn rewards.",
    setup: {
      keyLabel: "API key",
      secretLabel: "Private key",
      steps:
        "In Kraken, open Settings → Connections & API and create a key with only Query Funds and Query Ledger Entries ticked (nothing that trades, deposits or withdraws).",
      url: "https://www.kraken.com/u/security/api",
    },
  },
  {
    key: "gemini",
    name: "Gemini",
    status: "active",
    sync: "api",
    note: "Syncs trades, deposits and withdrawals.",
    setup: {
      keyLabel: "API key (account-…)",
      secretLabel: "API secret",
      steps:
        "In Gemini, open Settings → API and create a key with the Auditor role (read-only): an account key, or a master key to cover every account in your group. You can leave “Uses a time based nonce” unchecked (Muny handles either).",
      url: "https://exchange.gemini.com/settings/api",
    },
  },
  {
    key: "binance_us",
    name: "Binance US",
    status: "active",
    sync: "api",
    note: "Syncs trades, buys and conversions, deposits, withdrawals and staking rewards. Binance US only answers coin by coin, so Muny asks about coins this wallet has held; the first sync takes a few minutes.",
    setup: {
      keyLabel: "API key",
      secretLabel: "Secret key",
      steps:
        "In Binance.US, open API Management, create a system-generated key and leave only “Can Read” enabled.",
      url: "https://www.binance.us/settings/api-management",
    },
  },
  {
    key: "uphold",
    name: "Uphold",
    status: "active",
    sync: "import",
    note: "Uphold only gives API access to registered developer apps and business accounts, so Muny can't sync a personal account. Import your history (Koinly, or Uphold's transaction export) and add new transactions by hand.",
  },
  {
    key: "changelly",
    name: "Changelly",
    status: "active",
    sync: "import",
    note: "Changelly swaps coins without keeping an account balance, and has no API for your history. Each swap shows up in the wallets that sent and received it; imported rows keep the record.",
  },
  {
    key: "bittrex",
    name: "Bittrex",
    status: "closed",
    sync: "import",
    closedOn: "2023-12-04",
    note: "Bittrex closed: Bittrex US stopped trading in 2023 and went through bankruptcy, and Bittrex Global shut down in December 2023. Its history comes from your import. If coins were still there, mark them lost (or record the withdrawal you got); then archive it.",
  },
  {
    key: "tradeogre",
    name: "TradeOgre",
    status: "closed",
    sync: "import",
    closedOn: "2025-09-18",
    note: "TradeOgre was shut down and its funds seized by Canadian police (RCMP) in September 2025; withdrawals aren't possible. Its history comes from your import. If coins were still there, mark them lost; then archive it.",
  },
];

export const cryptoExchange = (key: string | null | undefined) =>
  CRYPTO_EXCHANGES.find((x) => x.key === key) ?? null;

/** An exchange from a wallet's name ("Coinbase Pro", "Binance US", "Kraken"…). */
export function guessCryptoExchange(name: string): string | null {
  const n = name.toLowerCase();
  if (/coinbase\s*pro|gdax/.test(n)) return "coinbase_pro";
  if (/coinbase/.test(n)) return "coinbase";
  if (/binance\s*\.?\s*us/.test(n)) return "binance_us";
  if (/kraken/.test(n)) return "kraken";
  if (/gemini/.test(n)) return "gemini";
  if (/uphold/.test(n)) return "uphold";
  if (/bittrex/.test(n)) return "bittrex";
  if (/changelly/.test(n)) return "changelly";
  if (/trade\s*ogre/.test(n)) return "tradeogre";
  return null;
}

/** A 1099-DA (or similar) form an exchange sent for a tax year. */
export interface CryptoTaxDoc {
  id: string;
  walletId: string;
  year: number;
  filename: string;
  size: number;
  /** The form reports cost basis to the IRS (Form 8949 box G/J instead of H/K). */
  basisReported: boolean;
  uploadedAt: number;
}

/** The reports Muny can make for a tax year (CSV). */
export const CRYPTO_TAX_REPORTS = [
  [
    "capital-gains",
    "Capital gains report",
    "Every sale, spend and fee: dates, proceeds, cost, gain, term",
  ],
  [
    "form-8949",
    "Form 8949 lines",
    "Ready to copy into Form 8949 (Parts I/II, the box from your 1099-DA forms)",
  ],
  ["income", "Income report", "Rewards, staking, mining, airdrops and other income at their value"],
  ["expenses", "Expenses report", "Coins spent (tagged Cost)"],
  [
    "gifts",
    "Gifts, donations & lost assets",
    "What left as a gift, donation or loss, at its value",
  ],
  [
    "holdings-start",
    "Beginning of year holdings",
    "What you held on January 1, with cost and value",
  ],
  ["holdings-end", "End of year holdings", "What you held on December 31, with cost and value"],
  ["balances", "Balances per wallet", "Each wallet's coins at the end of the year"],
  ["transactions", "Transaction history", "Every crypto transaction in the year"],
] as const;
export type CryptoTaxReportKind = (typeof CRYPTO_TAX_REPORTS)[number][0];

/** One lot still held: what it cost and when it was acquired (FIFO order). */
export interface CryptoTaxLot {
  acquiredAt: number;
  amount: string;
  costCents: number;
  /** When it turns long term (held more than a year). */
  longFrom: number;
}

/** The tax view: flows and realized gains for a range, and what's held by term. */
export interface CryptoTaxReport {
  from: number;
  to: number;
  /** Values in cents for the range (unknown values aren't counted). */
  summary: {
    inCents: number;
    outCents: number;
    incomeCents: number;
    expensesCents: number;
    feesCents: number;
    /** Gifts, donations and lost coins (their value when they left). */
    giftsCents: number;
    realizedCents: number;
  };
  /** Transactions in the range, by type. */
  counts: { total: number; deposit: number; withdrawal: number; trade: number; transfer: number };
  /** Transactions in the range. */
  txnCount: number;
  /** The tax year of the range's end: realized gains by term. */
  year: number;
  realized: {
    short: { profitCents: number; lossCents: number };
    long: { profitCents: number; lossCents: number };
  };
  assets: {
    asset: string;
    name: string;
    amount: string;
    priceUsd: string | null;
    valueCents: number | null;
    short: { amount: string; costCents: number; valueCents: number | null };
    long: { amount: string; costCents: number; valueCents: number | null };
    lots: CryptoTaxLot[];
    /** Some lots have no known cost (missing purchase history or prices). */
    missingCost: boolean;
  }[];
  /** Share of today's value that is long term, month by month for a year. */
  maturity: { at: number; longPct: number }[];
}

/** An NFT held in one of your synced wallets. */
export interface CryptoNft {
  walletId: string;
  walletName: string;
  chain: string | null;
  contract: string;
  tokenId: string;
  type: string;
  name: string | null;
  collection: string | null;
  /** Image link on another site; load only when the user asks. */
  image: string | null;
  amount: string;
}
