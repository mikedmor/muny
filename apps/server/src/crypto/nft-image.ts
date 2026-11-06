import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { MunyDb } from "@muny/db";
import { schema } from "@muny/db";
import { eq } from "drizzle-orm";
import { getCryptoSettings } from "./prices.js";
import { readCursor } from "./sync.js";

/**
 * NFT images, fetched by this server for the browser (opt-in: Crypto →
 * Settings). The page's Content-Security-Policy keeps images to this site,
 * and the image hosts see the server instead of the viewer.
 *
 * Only an image link stored for one of the user's NFTs is fetched (no
 * arbitrary URLs). NFT metadata is written by whoever made the token, so a
 * link could point inside the home network: hosts that resolve to private,
 * loopback or link-local addresses are refused, redirects are checked the same
 * way (at most 3), only images are passed on, up to 5 MB, within 15 seconds.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export class NftImageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** True for addresses that aren't on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return (
    v === "::" ||
    v === "::1" ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe8") ||
    v.startsWith("fe9") ||
    v.startsWith("fea") ||
    v.startsWith("feb") ||
    v.startsWith("ff")
  );
}

async function assertPublic(url: URL, resolve: typeof lookup) {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new NftImageError("Not a web link", 400);
  if (url.username || url.password) throw new NftImageError("Not allowed", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new NftImageError("Not allowed", 400);
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address)))
    throw new NftImageError("Not allowed", 400);
}

export async function fetchNftImage(
  db: MunyDb,
  q: { walletId: string; contract: string; tokenId: string },
  deps: { fetch?: typeof fetch; resolve?: typeof lookup } = {},
): Promise<{ type: string; body: Buffer }> {
  if (!getCryptoSettings(db).nftImages)
    throw new NftImageError("NFT images are off (Crypto → Settings)", 403);
  const wallet = db
    .select({ cursor: schema.cryptoWallets.syncCursor })
    .from(schema.cryptoWallets)
    .where(eq(schema.cryptoWallets.id, q.walletId))
    .get();
  const nft = readCursor(wallet?.cursor ?? null)?.nfts?.find(
    (n) => n.contract === q.contract.toLowerCase() && n.tokenId === q.tokenId,
  );
  if (!nft?.image) throw new NftImageError("No image for that NFT", 404);
  const f = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? lookup;
  let url = new URL(nft.image.replace(/^ipfs:\/\/(ipfs\/)?/i, "https://ipfs.io/ipfs/"));
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublic(url, resolve);
    let res: Response;
    try {
      res = await f(url, {
        redirect: "manual",
        headers: { accept: "image/*", "user-agent": "Muny (self-hosted)" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new NftImageError("Couldn't load the image", 502);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) break;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) throw new NftImageError("Couldn't load the image", 502);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!type.startsWith("image/")) throw new NftImageError("Not an image", 502);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES)
      throw new NftImageError("Image too large", 502);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new NftImageError("Image too large", 502);
    return { type, body };
  }
  throw new NftImageError("Too many redirects", 502);
}
