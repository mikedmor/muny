import { openDb } from "@muny/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

export const OWNER = { email: "owner@example.com", password: "correct horse battery" };

export interface AppOptions {
  env?: Record<string, string>;
  alertFetch?: typeof fetch;
}

export async function makeApp(env: Record<string, string> = {}, opts: AppOptions = {}) {
  const config = loadConfig({ NODE_ENV: "test", ...env, ...opts.env });
  const db = openDb({ filename: ":memory:" });
  const app = await buildApp({ config, db, alertFetch: opts.alertFetch });
  return { app, db, config };
}

/** Small client that keeps the session cookie and sends the CSRF header. */
export class TestClient {
  cookie: string | undefined;
  constructor(private app: FastifyInstance) {}

  async request(opts: InjectOptions) {
    const headers: Record<string, string> = { "x-muny-csrf": "1", ...(opts.headers as object) };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.inject({ ...opts, headers });
    const set = res.cookies.find((c) => c.name === "muny_session");
    if (set) this.cookie = set.value ? `muny_session=${set.value}` : undefined;
    return res;
  }
  get(url: string) {
    return this.request({ method: "GET", url });
  }
  post(url: string, payload?: unknown) {
    return this.request({ method: "POST", url, payload: payload as InjectOptions["payload"] });
  }
  patch(url: string, payload?: unknown) {
    return this.request({ method: "PATCH", url, payload: payload as InjectOptions["payload"] });
  }
  put(url: string, payload?: unknown) {
    return this.request({ method: "PUT", url, payload: payload as InjectOptions["payload"] });
  }
  delete(url: string) {
    return this.request({ method: "DELETE", url });
  }
}

/** App with the owner account created and a signed-in client. */
export async function makeSignedInApp(opts: AppOptions = {}) {
  const ctx = await makeApp({}, opts);
  const client = new TestClient(ctx.app);
  const res = await client.post("/api/auth/setup", OWNER);
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return { ...ctx, client };
}
