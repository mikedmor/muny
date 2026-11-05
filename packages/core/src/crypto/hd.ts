import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";

/**
 * Addresses from an extended public key (xpub/ypub/zpub, Ltub/Mtub, dgub),
 * derived locally so the key itself never leaves Muny: only the derived
 * addresses are looked up. Public keys only; nothing here can spend.
 */

const b58 = createBase58check(sha256);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

export type HdCoin = "btc" | "ltc" | "doge" | "zec";
type Script = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

/** Extended key version bytes → script type (per coin where they differ). */
const VERSIONS: Record<string, { version: number; script: Script; coins: HdCoin[] }> = {
  xpub: { version: 0x0488b21e, script: "p2pkh", coins: ["btc", "ltc", "doge", "zec"] },
  ypub: { version: 0x049d7cb2, script: "p2sh-p2wpkh", coins: ["btc", "ltc"] },
  zpub: { version: 0x04b24746, script: "p2wpkh", coins: ["btc", "ltc"] },
  Ltub: { version: 0x019da462, script: "p2pkh", coins: ["ltc"] },
  Mtub: { version: 0x01b26ef6, script: "p2sh-p2wpkh", coins: ["ltc"] },
  dgub: { version: 0x02facafd, script: "p2pkh", coins: ["doge"] },
};

const NET: Record<HdCoin, { p2pkh: number[]; p2sh: number[]; hrp?: string }> = {
  btc: { p2pkh: [0x00], p2sh: [0x05], hrp: "bc" },
  ltc: { p2pkh: [0x30], p2sh: [0x32], hrp: "ltc" },
  doge: { p2pkh: [0x1e], p2sh: [0x16] },
  zec: { p2pkh: [0x1c, 0xb8], p2sh: [0x1c, 0xbd] },
};

export function isSupportedXpub(key: string, coin: HdCoin): boolean {
  const v = VERSIONS[key.slice(0, 4)];
  return !!v && v.coins.includes(coin);
}

export class HdAccount {
  private readonly key: HDKey;
  private readonly script: Script;
  constructor(
    xpub: string,
    private readonly coin: HdCoin,
  ) {
    const v = VERSIONS[xpub.slice(0, 4)];
    if (!v?.coins.includes(coin)) throw new Error("Unsupported extended public key");
    this.script = v.script;
    this.key = HDKey.fromExtendedKey(xpub, { private: 0, public: v.version });
  }

  /** Address at chain (0 receive, 1 change) / index. */
  address(chain: 0 | 1, index: number): string {
    const pub = this.key.deriveChild(chain).deriveChild(index).publicKey;
    if (!pub) throw new Error("Couldn't derive a public key");
    return encodeAddress(pub, this.coin, this.script);
  }
}

export function encodeAddress(pub: Uint8Array, coin: HdCoin, script: Script): string {
  const net = NET[coin];
  const h = hash160(pub);
  if (script === "p2wpkh") {
    if (!net.hrp) throw new Error("No SegWit addresses on this chain");
    return bech32.encode(net.hrp, [0, ...bech32.toWords(h)]);
  }
  if (script === "p2sh-p2wpkh") {
    const redeem = new Uint8Array([0x00, 0x14, ...h]);
    return b58.encode(new Uint8Array([...net.p2sh, ...hash160(redeem)]));
  }
  return b58.encode(new Uint8Array([...net.p2pkh, ...h]));
}

/** TRON base58 address (T…) → hex form ("41" + 20 bytes) used by some APIs. */
export function tronToHex(address: string): string {
  const bytes = b58.decode(address);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
