import { describe, expect, it } from "vitest";
import { HdAccount, isSupportedXpub, tronToHex } from "./hd.js";

// Public BIP test vectors (mnemonic "abandon … about"); not anyone's wallet.
const XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const YPUB =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("HD address derivation", () => {
  it("matches BIP44/49/84 test vectors", () => {
    expect(new HdAccount(XPUB, "btc").address(0, 0)).toBe("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");
    expect(new HdAccount(YPUB, "btc").address(0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
    const z = new HdAccount(ZPUB, "btc");
    expect(z.address(0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(z.address(1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });

  it("encodes other coins' address formats", () => {
    expect(new HdAccount(ZPUB, "ltc").address(0, 0)).toMatch(/^ltc1q/);
    expect(new HdAccount(XPUB, "doge").address(0, 0)).toMatch(/^D/);
    expect(new HdAccount(XPUB, "zec").address(0, 0)).toMatch(/^t1/);
    expect(isSupportedXpub(ZPUB, "doge")).toBe(false);
    expect(() => new HdAccount(ZPUB, "doge")).toThrow();
  });
});

describe("TRON addresses", () => {
  it("converts base58 to hex", () => {
    // The well-known TRON zero address.
    expect(tronToHex("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).toBe(
      "410000000000000000000000000000000000000000",
    );
  });
});
