import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * argon2id password hashing using Node's built-in implementation.
 * Parameters follow OWASP's minimum recommendation (19 MiB, t=2, p=1), which
 * keeps a login under ~50 ms on a Synology J4125.
 * Stored as a PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 */
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;

function argon2id(
  password: string,
  salt: Buffer,
  p: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, ...p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
    stored,
  );
  if (!m) return false;
  const [, mem, t, p, saltB64, hashB64] = m;
  const expected = Buffer.from(hashB64 as string, "base64");
  const actual = await argon2id(password, Buffer.from(saltB64 as string, "base64"), {
    memory: Number(mem),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used to equalize timing when the user doesn't exist. */
let dummyHash: Promise<string> | undefined;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword("muny-dummy-password");
  return dummyHash.then((h) => verifyPassword(password, h)).then(() => false);
}

export const PASSWORD_MIN_LENGTH = 10;
