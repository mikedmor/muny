import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption for provider credentials at rest (AES-256-GCM).
 *
 * The data key is derived from MUNY_SECRET_KEY with HKDF, so the raw secret
 * is never used directly and other purposes can derive their own keys.
 * Stored format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */

const INFO = "muny:credentials:v1";

export function deriveKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
}

export function encryptJson(secret: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export class DecryptError extends Error {}

export function decryptJson<T>(secret: Buffer, stored: string): T {
  if (!stored.startsWith("v1:")) throw new DecryptError("Unknown credential format");
  const buf = Buffer.from(stored.slice(3), "base64");
  if (buf.length < 29) throw new DecryptError("Credential blob is truncated");
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as T;
  } catch {
    // Wrong MUNY_SECRET_KEY or tampered data. Never include the blob in the message.
    throw new DecryptError("Couldn't decrypt stored credentials. Was MUNY_SECRET_KEY changed?");
  }
}

/**
 * Files at rest (e.g. tax forms): AES-256-GCM with a key derived for files,
 * stored as iv[12] | tag[16] | ciphertext.
 */
const FILE_INFO = "muny:files:v1";
const fileKey = (secret: Buffer) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), FILE_INFO, 32));

export function encryptBytes(secret: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(secret), iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(secret: Buffer, stored: Buffer): Buffer {
  if (stored.length < 29) throw new DecryptError("File is truncated");
  try {
    const decipher = createDecipheriv("aes-256-gcm", fileKey(secret), stored.subarray(0, 12));
    decipher.setAuthTag(stored.subarray(12, 28));
    return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
  } catch {
    throw new DecryptError("Couldn't decrypt the file. Was MUNY_SECRET_KEY changed?");
  }
}
