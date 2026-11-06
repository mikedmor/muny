import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import type { AlertRule, NotificationChannel } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { encryptPayload } from "./webpush.js";

// A fake browser: its own keys, decrypting like a real one would (RFC 8291).
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, 9);
  const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(body: Buffer) {
      const salt = body.subarray(0, 16);
      const idlen = body[20] as number;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, shared);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
      const ikm = hmac(prkKey, Buffer.concat([info, Buffer.from([1])])).subarray(0, 32);
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      return plain.subarray(0, plain.lastIndexOf(2)).toString();
    },
  };
}

const SECRET = Buffer.alloc(32, 3).toString("base64");

describe("web push", () => {
  it("encrypts so only the browser can read it", () => {
    const b = browser();
    const body = encryptPayload(b.p256dh, b.auth, Buffer.from('{"title":"Hi"}'));
    expect(b.decrypt(body)).toBe('{"title":"Hi"}');
  });

  it("subscribes a device as a channel and sends it alerts, signed and encrypted", async () => {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    let status = 201;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(init.body as Uint8Array),
      });
      return new Response("", { status });
    }) as unknown as typeof fetch;
    const { client } = await makeSignedInApp({
      env: { MUNY_SECRET_KEY: SECRET, MUNY_PUBLIC_URL: "https://muny.example.ts.net" },
      alertFetch: fakeFetch,
    });
    const { publicKey } = (await client.get("/api/alerts/push/key")).json<{ publicKey: string }>();
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);

    const b = browser();
    const sub = {
      endpoint: "https://push.example.com/send/abc123",
      keys: { p256dh: b.p256dh, auth: b.auth },
      device: "Android · Chrome",
    };
    const res = await client.post("/api/alerts/push/subscribe", sub);
    expect(res.statusCode).toBe(200);
    const chan = res.json<NotificationChannel>();
    expect(chan).toMatchObject({ type: "push", name: "Android · Chrome" });
    expect(JSON.stringify(chan)).not.toContain("abc123");
    // Same device again: the same channel.
    expect(
      (await client.post("/api/alerts/push/subscribe", sub)).json<NotificationChannel>().id,
    ).toBe(chan.id);
    // It gets the alerts that are on.
    const rules = (await client.get("/api/alerts/rules")).json<AlertRule[]>();
    expect(rules.find((r) => r.type === "bill_due")?.channelIds).toEqual([chan.id]);

    expect((await client.post(`/api/alerts/channels/${chan.id}/test`)).statusCode).toBe(200);
    const msg = sent.at(-1);
    expect(msg?.url).toBe(sub.endpoint);
    expect(msg?.headers["content-encoding"]).toBe("aes128gcm");
    expect(JSON.parse(b.decrypt(msg?.body as Buffer)).title).toBeTruthy();
    // VAPID: a token for the push service's origin, signed by this server's key.
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(msg?.headers.authorization ?? "") ?? [];
    expect(k).toBe(publicKey);
    const [h, c, sig] = (token as string).split(".");
    expect(JSON.parse(Buffer.from(c as string, "base64url").toString()).aud).toBe(
      "https://push.example.com",
    );
    const pub = Buffer.from(publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig as string, "base64url"),
      ),
    ).toBe(true);

    // The device turned notifications off: the channel stops.
    status = 410;
    await client.post(`/api/alerts/channels/${chan.id}/test`);
    const after = (await client.get("/api/alerts/channels")).json<NotificationChannel[]>();
    expect(after.find((x) => x.id === chan.id)?.enabled).toBe(false);
  });
});
