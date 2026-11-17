import { createDecipheriv, createECDH, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationChannel } from "@muny/shared";
import { afterEach, describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { loadFcmCredentials, resetFcmToken, sendFcm } from "./fcm.js";
import { PushGone } from "./webpush.js";

// The Android app's side: its own keys, decrypting like WebPushKeys.java (RFC 8291).
function phone() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(body: Buffer) {
      const salt = body.subarray(0, 16);
      const idlen = body[20] as number;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
      const ikm = hmac(prkKey, Buffer.concat([info, Buffer.from([1])]));
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

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const creds = {
  projectId: "muny-test",
  clientEmail: "fcm@muny-test.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function keyFile(json: object) {
  const dir = mkdtempSync(join(tmpdir(), "muny-fcm-"));
  const f = join(dir, "key.json");
  writeFileSync(f, JSON.stringify(json));
  return f;
}

/** Google's token endpoint and FCM, recording what was sent. */
function fakeGoogle(fcmStatus = 200, fcmBody = "{}") {
  const calls: { url: string; body: string; auth?: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body: String(init.body), auth: headers.authorization });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    return new Response(fcmBody, { status: fcmStatus });
  }) as unknown as typeof fetch;
  return { f, calls };
}

afterEach(() => resetFcmToken());

describe("Firebase notifications (Android app)", () => {
  it("reads a service-account key file and refuses anything else", () => {
    const f = keyFile({
      type: "service_account",
      project_id: creds.projectId,
      client_email: creds.clientEmail,
      private_key: creds.privateKey,
    });
    expect(loadFcmCredentials(f)).toEqual(creds);
    expect(() => loadFcmCredentials(keyFile({ project_info: {} }))).toThrow(/service-account/);
    expect(() => loadFcmCredentials(join(tmpdir(), "no-such-key.json"))).toThrow(/couldn't read/);
  });

  it("signs in with a signed JWT, then sends the notification encrypted for the phone only", async () => {
    const p = phone();
    const { f, calls } = fakeGoogle();
    await sendFcm(
      { endpoint: "fcm:dTok3n:APA91b-abcdefghijklmnop", p256dh: p.p256dh, auth: p.auth },
      { title: "Bill due", body: "Netflix tomorrow", id: "n1" },
      { credentials: creds },
      f,
    );
    const [token, send] = calls;
    // The JWT is signed by the service account's key, for FCM only.
    const assertion = new URLSearchParams(token?.body).get("assertion") ?? "";
    const [h, c, s] = assertion.split(".");
    expect(
      verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s ?? "", "base64url")),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toMatchObject({
      iss: creds.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    // The message: to that token, only ciphertext, which the phone can open.
    expect(send?.url).toBe("https://fcm.googleapis.com/v1/projects/muny-test/messages:send");
    expect(send?.auth).toBe("Bearer ya29.test");
    const msg = JSON.parse(send?.body ?? "{}").message;
    expect(msg.token).toBe("dTok3n:APA91b-abcdefghijklmnop");
    expect(send?.body).not.toContain("Netflix");
    expect(JSON.parse(p.decrypt(Buffer.from(msg.data.p, "base64url")))).toMatchObject({
      title: "Bill due",
      body: "Netflix tomorrow",
    });
    // The access token is reused.
    await sendFcm(
      { endpoint: "fcm:dTok3n:APA91b-abcdefghijklmnop", p256dh: p.p256dh, auth: p.auth },
      { title: "Again" },
      { credentials: creds },
      f,
    );
    expect(calls.filter((x) => x.url.startsWith("https://oauth2"))).toHaveLength(1);
  });

  it("treats an uninstalled app as gone", async () => {
    const p = phone();
    const sub = { endpoint: "fcm:old-token-abcdefghijklmnop", p256dh: p.p256dh, auth: p.auth };
    const gone = fakeGoogle(
      404,
      '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
    );
    await expect(
      sendFcm(sub, { title: "x" }, { credentials: creds }, gone.f),
    ).rejects.toBeInstanceOf(PushGone);
    resetFcmToken();
    const down = fakeGoogle(503);
    await expect(sendFcm(sub, { title: "x" }, { credentials: creds }, down.f)).rejects.toThrow(
      "FCM answered 503",
    );
  });

  it("registers the app like a browser, unless app notifications are turned off", async () => {
    const p = phone();
    const sub = {
      endpoint: "fcm:dTok3n:APA91b-abcdefghijklmnop",
      keys: { p256dh: p.p256dh, auth: p.auth },
      device: "Android app",
    };
    const SECRET = Buffer.alloc(32, 3).toString("base64");
    const without = await makeSignedInApp({
      env: { MUNY_SECRET_KEY: SECRET, MUNY_PUSH_RELAY: "off" },
    });
    const refused = await without.client.post("/api/alerts/push/subscribe", sub);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toMatch(/MUNY_PUSH_RELAY/);

    const { f, calls } = fakeGoogle();
    const file = keyFile({
      type: "service_account",
      project_id: creds.projectId,
      client_email: creds.clientEmail,
      private_key: creds.privateKey,
    });
    const { client } = await makeSignedInApp({
      env: { MUNY_SECRET_KEY: SECRET, MUNY_FCM_CREDENTIALS: file },
      alertFetch: f,
    });
    const res = await client.post("/api/alerts/push/subscribe", sub);
    expect(res.statusCode).toBe(200);
    const chan = res.json<NotificationChannel>();
    expect(chan).toMatchObject({ type: "push", name: "Android app" });
    const test = await client.post(`/api/alerts/channels/${chan.id}/test`, {});
    expect(test.statusCode).toBe(200);
    const send = calls.find((x) => x.url.includes("fcm.googleapis.com"));
    const msg = JSON.parse(send?.body ?? "{}").message;
    expect(JSON.parse(p.decrypt(Buffer.from(msg.data.p, "base64url"))).title).toBeTruthy();
  });
});

describe("the push relay (the published app, no Firebase key needed)", () => {
  it("hands the relay only the token and the ciphertext, and stops when the app is gone", async () => {
    const p = phone();
    const sub = { endpoint: "fcm:dTok3n:APA91b-abcdefghijklmnop", p256dh: p.p256dh, auth: p.auth };
    const calls: { url: string; body: string }[] = [];
    let status = 200;
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    await sendFcm(
      sub,
      { title: "Low balance", body: "Checking is at $40" },
      { relay: "https://relay.test/" },
      f,
    );
    expect(calls[0]?.url).toBe("https://relay.test/v1/send");
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(Object.keys(sent).sort()).toEqual(["p", "token"]);
    expect(sent.token).toBe("dTok3n:APA91b-abcdefghijklmnop");
    expect(calls[0]?.body).not.toContain("Checking");
    expect(JSON.parse(p.decrypt(Buffer.from(sent.p, "base64url"))).title).toBe("Low balance");
    status = 410;
    await expect(
      sendFcm(sub, { title: "x" }, { relay: "https://relay.test" }, f),
    ).rejects.toBeInstanceOf(PushGone);
    status = 429;
    await expect(sendFcm(sub, { title: "x" }, { relay: "https://relay.test" }, f)).rejects.toThrow(
      "relay answered 429",
    );
  });

  it("is what a fresh Muny uses, and only over https", async () => {
    const { loadConfig } = await import("../config.js");
    const { DEFAULT_PUSH_RELAY } = await import("./fcm.js");
    expect(loadConfig({}).fcm).toEqual({ relay: DEFAULT_PUSH_RELAY });
    expect(loadConfig({ MUNY_PUSH_RELAY: "https://push.example" }).fcm).toEqual({
      relay: "https://push.example",
    });
    expect(loadConfig({ MUNY_PUSH_RELAY: "off" }).fcm).toBeNull();
    expect(() => loadConfig({ MUNY_PUSH_RELAY: "http://push.example" })).toThrow(/https/);
  });
});
