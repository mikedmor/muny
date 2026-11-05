import { type HdCoin, isSupportedXpub } from "./hd.js";

/**
 * Chains Muny can sync from public data. Each wallet syncs through a provider:
 * - blockscout: EVM chains (open-source explorer; one free key covers them all,
 *   or each chain's public instance without a key).
 * - esplora (Bitcoin, Litecoin: mempool.space / litecoinspace.org) and
 *   blockcypher (Dogecoin); extended public keys are expanded locally.
 * - blockbook: a Blockbook server you set (Zcash: no free public one).
 * - siascan: Siacoin through SiaScan's public explorer API.
 * - koios (Cardano), algonode (Algorand), horizon (Stellar), cosmos (Cosmos Hub
 *   REST node), trongrid (TRON): free public APIs.
 * Servers are configurable per chain.
 */

export type ChainKey =
  | "btc"
  | "ltc"
  | "doge"
  | "zec"
  | "sc"
  | "eth"
  | "base"
  | "op"
  | "arb"
  | "polygon"
  | "gnosis"
  | "ada"
  | "algo"
  | "xlm"
  | "atom"
  | "trx";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  asset: string;
  decimals: number;
  provider:
    | "esplora"
    | "blockcypher"
    | "none"
    | "blockbook"
    | "siascan"
    | "blockscout"
    | "koios"
    | "algonode"
    | "horizon"
    | "cosmos"
    | "trongrid";
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
/** An extended public key this coin's address formats support. */
const xpubFor = (coin: HdCoin) => (s: string) => XPUB.test(s) && isSupportedXpub(s, coin);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const EVM = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

export const CHAINS: Record<ChainKey, ChainInfo> = {
  btc: {
    key: "btc",
    name: "Bitcoin",
    asset: "BTC",
    decimals: 8,
    provider: "esplora",
    server: "https://mempool.space/api",
    accepts: "xpub / ypub / zpub (recommended: covers every address) or a single address",
    validate: (s) =>
      xpubFor("btc")(s) ||
      /^bc1[02-9ac-hj-np-z]{11,71}$/i.test(s) ||
      (/^[13]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  ltc: {
    key: "ltc",
    name: "Litecoin",
    asset: "LTC",
    decimals: 8,
    provider: "esplora",
    server: "https://litecoinspace.org/api",
    accepts: "Ltub / Mtub / zpub or a single address",
    validate: (s) =>
      xpubFor("ltc")(s) ||
      /^ltc1[02-9ac-hj-np-z]{11,71}$/i.test(s) ||
      (/^[LM3]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  doge: {
    key: "doge",
    name: "Dogecoin",
    asset: "DOGE",
    decimals: 8,
    provider: "blockcypher",
    server: "https://api.blockcypher.com/v1/doge/main",
    accepts: "dgub / xpub or a single address (starts with D)",
    validate: (s) =>
      xpubFor("doge")(s) ||
      (/^[DA9]/.test(s) && BASE58.test(s) && s.length >= 26 && s.length <= 35),
  },
  zec: {
    key: "zec",
    name: "Zcash",
    asset: "ZEC",
    decimals: 8,
    provider: "blockbook",
    server: "",
    accepts: "xpub or a transparent address (starts with t1 or t3)",
    validate: (s) => xpubFor("zec")(s) || (/^t[13]/.test(s) && BASE58.test(s) && s.length === 35),
  },
  sc: {
    key: "sc",
    name: "Siacoin",
    asset: "SC",
    decimals: 24,
    provider: "siascan",
    server: "https://api.siascan.com",
    accepts: "address (76 characters; several separated by commas, since a Sia wallet uses many)",
    validate: (s) => {
      const list = s.split(/[\s,;]+/).filter(Boolean);
      return list.length > 0 && list.length <= 50 && list.every((a) => /^[0-9a-fA-F]{76}$/.test(a));
    },
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
  ada: {
    key: "ada",
    name: "Cardano",
    asset: "ADA",
    decimals: 6,
    provider: "koios",
    server: "https://api.koios.rest/api/v1",
    accepts: "a stake address (stake1…, covers the whole wallet) or an address (addr1…)",
    validate: (s) => /^(stake1[02-9ac-hj-np-z]{50,60}|addr1[02-9ac-hj-np-z]{50,110})$/.test(s),
  },
  algo: {
    key: "algo",
    name: "Algorand",
    asset: "ALGO",
    decimals: 6,
    provider: "algonode",
    server: "https://mainnet-idx.algonode.cloud",
    accepts: "an address (58 capital letters and digits); tokens are included",
    validate: (s) => /^[A-Z2-7]{58}$/.test(s),
  },
  xlm: {
    key: "xlm",
    name: "Stellar",
    asset: "XLM",
    decimals: 7,
    provider: "horizon",
    server: "https://horizon.stellar.org",
    accepts: "an account (G…, 56 characters); tokens are included",
    validate: (s) => /^G[A-Z2-7]{55}$/.test(s),
  },
  atom: {
    key: "atom",
    name: "Cosmos Hub",
    asset: "ATOM",
    decimals: 6,
    provider: "cosmos",
    server: "https://rest.cosmos.directory/cosmoshub",
    accepts: "an address (cosmos1…)",
    validate: (s) => /^cosmos1[02-9ac-hj-np-z]{38}$/.test(s),
  },
  trx: {
    key: "trx",
    name: "TRON",
    asset: "TRX",
    decimals: 6,
    provider: "trongrid",
    server: "https://api.trongrid.io",
    accepts: "an address (T…, 34 characters); tokens are included",
    validate: (s) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s),
  },
};

export const isExtendedKey = (s: string) => XPUB.test(s);

/** Safe display hint: first 6 and last 5 characters. */
export const sourceHint = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-5)}` : s);
