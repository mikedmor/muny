import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { type MunyDb, schema } from "@muny/db";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Web Push (notifications on a phone or computer with Muny installed or open
 * in the browser): VAPID (RFC 8292) to identify this server, and aes128gcm
 * payload encryption (RFC 8291) so the push service only carries ciphertext.
 * Opt-in per device; each push goes to that browser's push service (Google
 * for Chrome/Android, Microsoft for Edge, Mozilla for Firefox, Apple).
 * Built on node:crypto, no extra dependency.
 */

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export interface Vapid {
  publicKey: string; // uncompressed P-256 point, base64url (the browser's applicationServerKey)
  privateJwk: { kty: string; crv: string; x: string; y: string; d: string };
}

const KEY = "alerts.vapid";

/** This server's VAPID keys, made once and kept encrypted. */
export function vapidKeys(db: MunyDb, secret: Buffer): Vapid {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY)).get();
  if (row && typeof row.value === "string") return decryptJson<Vapid>(secret, row.value);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as Vapid["privateJwk"];
  const v: Vapid = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
  };
  const value = encryptJson(secret, v);
  db.insert(schema.appSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
  return v;
}

function vapidHeader(v: Vapid, endpoint: string, subject: string, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const key = createPrivateKey({ key: v.privateJwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm, a single record). */
export function encryptPayload(
  p256dh: string,
  auth: string,
  payload: Buffer,
  salt = randomBytes(16),
) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export class PushGone extends Error {}

/** Send one notification. Throws PushGone when the device no longer accepts them. */
export async function sendWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string | null; tag?: string },
  v: Vapid,
  subject: string,
  f: typeof fetch = fetch,
) {
  const body = encryptPayload(sub.p256dh, sub.auth, Buffer.from(JSON.stringify(payload)));
  const res = await f(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidHeader(v, sub.endpoint, subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 410) throw new PushGone("gone");
  if (!res.ok) throw new Error(`push service answered ${res.status}`);
}
