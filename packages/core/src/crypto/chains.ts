/**
 * Chains Muny can sync from public data. Each wallet syncs through a provider:
 * - blockscout: EVM chains (open-source explorer; one free key covers them all,
 *   or each chain's public instance without a key).
 * - blockbook-utxo: Bitcoin-like chains (Blockbook API v2). Trezor's public
 *   servers refuse third-party apps, so these need a server you run or rent.
 * Servers are configurable per chain.
 */

export type ChainKey =
  | "btc"
  | "ltc"
  | "doge"
  | "zec"
  | "eth"
  | "base"
  | "op"
  | "arb"
  | "polygon"
  | "gnosis";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  asset: string;
  decimals: number;
  provider: "blockbook-utxo" | "blockscout";
  /** Default server: a Blockbook server, or the chain's public Blockscout instance. */
  server: string;
  /** EVM chain id (Blockscout's unified API addresses chains by id). */
  chainId?: number;
  /** What the user can paste. */
  accepts: string;
  /** Validate an address or extended public key for this chain. */
  validate: (s: string) => boolean;
}

// Extended public keys (BIP32/44/49/84) by prefix; base58 body.
const XPUB = /^(xpub|ypub|zpub|Ltub|Mtub|dgub|tpub|vpub|upub)[1-9A-HJ-NP-Za-km-z]{100,112}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const EVM = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

export const CHAINS: Record<ChainKey, ChainInfo> = {
  btc: {
    key: "btc",
    name: "Bitcoin",
    asset: "BTC",
    decimals: 8,
    provider: "blockbook-utxo",
    server: "",
    accepts: "xpub / ypub / zpub (recommended: covers every address) or a single address",
    validate: (s) =>
      XPUB.test(s) ||
      /^bc1[02-9ac-hj-np-z]{11,71}$/i.test(s) ||
      (/^[13]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  ltc: {
    key: "ltc",
    name: "Litecoin",
    asset: "LTC",
    decimals: 8,
    provider: "blockbook-utxo",
    server: "",
    accepts: "Ltub / Mtub / zpub or a single address",
    validate: (s) =>
      XPUB.test(s) ||
      /^ltc1[02-9ac-hj-np-z]{11,71}$/i.test(s) ||
      (/^[LM3]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  doge: {
    key: "doge",
    name: "Dogecoin",
    asset: "DOGE",
    decimals: 8,
    provider: "blockbook-utxo",
    server: "",
    accepts: "dgub / xpub or a single address (starts with D)",
    validate: (s) =>
      XPUB.test(s) || (/^[DA9]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  zec: {
    key: "zec",
    name: "Zcash",
    asset: "ZEC",
    decimals: 8,
    provider: "blockbook-utxo",
    server: "",
    accepts: "xpub or a transparent address (starts with t1 or t3)",
    validate: (s) => XPUB.test(s) || (/^t[13]/.test(s) && BASE58.test(s) && s.length === 35),
  },
  eth: {
    key: "eth",
    name: "Ethereum",
    asset: "ETH",
    decimals: 18,
    provider: "blockscout",
    server: "https://eth.blockscout.com",
    chainId: 1,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
  base: {
    key: "base",
    name: "Base",
    asset: "ETH",
    decimals: 18,
    provider: "blockscout",
    server: "https://base.blockscout.com",
    chainId: 8453,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
  op: {
    key: "op",
    name: "Optimism",
    asset: "ETH",
    decimals: 18,
    provider: "blockscout",
    server: "https://optimism.blockscout.com",
    chainId: 10,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
  arb: {
    key: "arb",
    name: "Arbitrum One",
    asset: "ETH",
    decimals: 18,
    provider: "blockscout",
    server: "https://arbitrum.blockscout.com",
    chainId: 42161,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
  polygon: {
    key: "polygon",
    name: "Polygon PoS",
    asset: "POL",
    decimals: 18,
    provider: "blockscout",
    server: "https://polygon.blockscout.com",
    chainId: 137,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
  gnosis: {
    key: "gnosis",
    name: "Gnosis",
    asset: "XDAI",
    decimals: 18,
    provider: "blockscout",
    server: "https://gnosis.blockscout.com",
    chainId: 100,
    accepts: "an address (0x…); tokens on the address are included",
    validate: EVM,
  },
};

export const isExtendedKey = (s: string) => XPUB.test(s);

/** Safe display hint: first 6 and last 5 characters. */
export const sourceHint = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-5)}` : s);
