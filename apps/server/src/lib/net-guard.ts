import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guards for fetching links that came from someone else (NFT metadata and
 * images): only http(s) to hosts on the public internet, so a crafted link
 * can't reach devices inside the home network.
 */

export class PublicUrlError extends Error {
  constructor() {
    super("Not a public web link");
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

/** Refuses links that aren't plain web links to public hosts (checked by DNS). */
export async function assertPublicUrl(url: URL, resolve: typeof lookup = lookup) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PublicUrlError();
  if (url.username || url.password) throw new PublicUrlError();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new PublicUrlError();
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new PublicUrlError();
}
