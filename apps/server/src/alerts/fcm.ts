import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { encryptPayload, PushGone } from "./webpush.js";

/**
 * Notifications to the Muny Android app, through Firebase Cloud Messaging
 * (HTTP v1). The app registers a device like a browser does, with an endpoint
 * of `fcm:<token>` and its own P-256 key + auth secret; each notification is
 * encrypted to those keys exactly like Web Push (RFC 8291) and sent as one
 * data field, so Google only carries ciphertext. Sent only for devices where
 * someone turned app notifications on: through the app's push relay
 * (MUNY_PUSH_RELAY, by default the published app's), or straight to Firebase
 * with your own key (MUNY_FCM_CREDENTIALS) for an app you built yourself.
 */

export const FCM_PREFIX = "fcm:";

/** The push relay for the published Android apps (app-shell/relay). */
export const DEFAULT_PUSH_RELAY = "https://app-shell-push.mikedmor.workers.dev";

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Reads a service-account key file from the Firebase console; throws a readable error. */
export function loadFcmCredentials(path: string): FcmCredentials {
  let json: { type?: string; project_id?: string; client_email?: string; private_key?: string };
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`MUNY_FCM_CREDENTIALS: couldn't read a JSON key file at ${path}`);
  }
  if (
    json.type !== "service_account" ||
    !json.project_id ||
    !json.client_email ||
    !json.private_key
  )
    throw new Error(
      "MUNY_FCM_CREDENTIALS must be a Firebase service-account key (Project settings → Service accounts → Generate new private key)",
    );
  return {
    projectId: json.project_id,
    clientEmail: json.client_email,
    privateKey: json.private_key,
  };
}

const b64u = (b: Buffer) => b.toString("base64url");
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cached: { email: string; token: string; until: number } | null = null;

/** An OAuth access token for FCM (a signed JWT exchanged with Google), reused for ~55 minutes. */
async function accessToken(c: FcmCredentials, f: typeof fetch, now = Date.now()) {
  if (cached && cached.email === c.clientEmail && cached.until > now) return cached.token;
  const iat = Math.floor(now / 1000);
  const head = b64u(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({ iss: c.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    ),
  );
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), createPrivateKey(c.privateKey));
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${head}.${claims}.${b64u(sig)}`,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Google sign-in answered ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google sign-in gave no token");
  cached = {
    email: c.clientEmail,
    token: body.access_token,
    until: now + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000,
  };
  return body.access_token;
}

/** For tests: forget the cached access token. */
export function resetFcmToken() {
  cached = null;
}

/**
 * How notifications reach the app: Firebase directly with your own key
 * (MUNY_FCM_CREDENTIALS, for an app you built yourself), or the app's push
 * relay (MUNY_PUSH_RELAY; by default the one for the published app).
 */
export type FcmRoute = { credentials: FcmCredentials } | { relay: string };

/** Send one encrypted notification to an app install. Throws PushGone when it's no longer there. */
export async function sendFcm(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: object,
  route: FcmRoute,
  f: typeof fetch = fetch,
) {
  const token = sub.endpoint.slice(FCM_PREFIX.length);
  const p = b64u(encryptPayload(sub.p256dh, sub.auth, Buffer.from(JSON.stringify(payload))));
  if ("relay" in route) return sendViaRelay(route.relay, token, p, f);
  const c = route.credentials;
  const res = await f(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await accessToken(c, f)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { token, data: { p }, android: { priority: "HIGH", ttl: "86400s" } },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (res.ok) return;
  if (res.status === 401) cached = null;
  const text = await res.text().catch(() => "");
  // The app was uninstalled or its token replaced.
  if (res.status === 404 || /UNREGISTERED|registration token is not a valid/i.test(text))
    throw new PushGone("gone");
  throw new Error(`FCM answered ${res.status}`);
}

/** The relay only ever gets the phone's token and the ciphertext (see app-shell/relay). */
async function sendViaRelay(relay: string, token: string, p: string, f: typeof fetch) {
  const res = await f(`${relay.replace(/\/+$/, "")}/v1/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, p }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return;
  if (res.status === 410) throw new PushGone("gone");
  throw new Error(`The push relay answered ${res.status}`);
}
