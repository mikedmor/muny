/**
 * Chains Muny can sync from public data. Each wallet syncs through a provider
 * (Blockbook: the open-source indexer Trezor runs for Trezor Suite). Servers are
 * configurable so a self-hosted Blockbook can be used instead.
 */

export type ChainKey = "btc" | "ltc" | "doge" | "zec" | "eth";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  asset: string;
  decimals: number;
  provider: "blockbook-utxo" | "blockbook-eth";
  /** Default public Blockbook server. */
  server: string;
  /** What the user can paste. */
  accepts: string;
  /** Validate an address or extended public key for this chain. */
  validate: (s: string) => boolean;
}

// Extended public keys (BIP32/44/49/84) by prefix; base58 body.
const XPUB = /^(xpub|ypub|zpub|Ltub|Mtub|dgub|tpub|vpub|upub)[1-9A-HJ-NP-Za-km-z]{100,112}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const CHAINS: Record<ChainKey, ChainInfo> = {
  btc: {
    key: "btc",
    name: "Bitcoin",
    asset: "BTC",
    decimals: 8,
    provider: "blockbook-utxo",
    server: "https://btc1.trezor.io",
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
    server: "https://ltc1.trezor.io",
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
    server: "https://doge1.trezor.io",
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
    server: "https://zec1.trezor.io",
    accepts: "xpub or a transparent address (starts with t1 or t3)",
    validate: (s) => XPUB.test(s) || (/^t[13]/.test(s) && BASE58.test(s) && s.length === 35),
  },
  eth: {
    key: "eth",
    name: "Ethereum",
    asset: "ETH",
    decimals: 18,
    provider: "blockbook-eth",
    server: "https://eth1.trezor.io",
    accepts: "an Ethereum address (0x…); tokens on the address are included",
    validate: (s) => /^0x[0-9a-fA-F]{40}$/.test(s),
  },
};

export const isExtendedKey = (s: string) => XPUB.test(s);

/** Safe display hint: first 6 and last 5 characters. */
export const sourceHint = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-5)}` : s);
