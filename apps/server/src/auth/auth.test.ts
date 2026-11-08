import { schema } from "@muny/db";
import { describe, expect, it } from "vitest";
import { makeApp, makeSignedInApp, OWNER, TestClient } from "../test-utils.js";
import { hashPassword, verifyPassword } from "./password.js";
import { RateLimiter } from "./rate-limit.js";

describe("password hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword("hunter2hunter2", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("uses a unique salt per hash", async () => {
    expect(await hashPassword("same-password!")).not.toBe(await hashPassword("same-password!"));
  });

  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("first-run setup", () => {
  it("reports setupRequired until the owner exists", async () => {
    const { app } = await makeApp();
    const client = new TestClient(app);
    expect((await client.get("/api/auth/status")).json()).toEqual({
      setupRequired: true,
      user: null,
    });

    const res = await client.post("/api/auth/setup", { ...OWNER, displayName: "Owner" });
    expect(res.statusCode).toBe(201);
    expect(client.cookie).toBeDefined();

    const status = (await client.get("/api/auth/status")).json();
    expect(status.setupRequired).toBe(false);
    expect(status.user).toMatchObject({ email: OWNER.email, role: "owner", displayName: "Owner" });
  });

  it("refuses a second setup", async () => {
    const { app } = await makeSignedInApp();
    const other = new TestClient(app);
    const res = await other.post("/api/auth/setup", {
      email: "x@example.com",
      password: "another-long-pw",
    });
    expect(res.statusCode).toBe(409);
  });

  it("validates email and password length", async () => {
    const { app } = await makeApp();
    const client = new TestClient(app);
    const res = await client.post("/api/auth/setup", { email: "nope", password: "short" });
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("never stores the plain password", async () => {
    const { db } = await makeSignedInApp();
    const user = db.select().from(schema.users).get();
    expect(user?.passwordHash).not.toContain(OWNER.password);
  });
});

describe("login / logout", () => {
  it("logs in with correct credentials (email is case-insensitive)", async () => {
    const { app } = await makeSignedInApp();
    const client = new TestClient(app);
    const res = await client.post("/api/auth/login", {
      email: OWNER.email.toUpperCase(),
      password: OWNER.password,
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "muny_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect((await client.get("/api/auth/status")).json().user.email).toBe(OWNER.email);
  });

  it("rejects wrong password and unknown users with the same message", async () => {
    const { app } = await makeSignedInApp();
    const client = new TestClient(app);
    const a = await client.post("/api/auth/login", {
      email: OWNER.email,
      password: "wrong-password",
    });
    const b = await client.post("/api/auth/login", {
      email: "who@example.com",
      password: "whatever-pw",
    });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it("logout invalidates the session server-side", async () => {
    const { app, client } = await makeSignedInApp();
    const stolen = client.cookie;
    await client.post("/api/auth/logout");
    const replay = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: stolen ?? "" },
    });
    expect(replay.json().user).toBeNull();
  });

  it("rate limits repeated failures", async () => {
    const { app } = await makeSignedInApp();
    const client = new TestClient(app);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await client.post("/api/auth/login", { email: OWNER.email, password: `bad-${i}` }))
        .statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("protection", () => {
  it("requires a session for private API routes", async () => {
    const { app } = await makeSignedInApp();
    const anon = new TestClient(app);
    expect((await anon.get("/api/anything")).statusCode).toBe(401);
  });

  it("blocks mutating requests without the CSRF header", async () => {
    const { app, client } = await makeSignedInApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: client.cookie ?? "" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sets security headers", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});

describe("RateLimiter", () => {
  it("resets after the window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit("k", 0)).toBe(0);
    expect(rl.hit("k", 1)).toBe(0);
    expect(rl.hit("k", 2)).toBeGreaterThan(0);
    expect(rl.hit("k", 1001)).toBe(0);
  });
});

describe("no way around signing in", () => {
  it("rejects encoded and odd spellings of protected routes", async () => {
    const { app, client } = await makeSignedInApp();
    await client.post("/api/accounts", { name: "Checking", type: "checking", balanceCents: 1234 });
    // The router decodes %-escapes: "/%61pi" is "/api", and must still need a session.
    for (const url of [
      "/%61pi/accounts",
      "/%61%70%69/accounts",
      "/api/v1/../accounts",
      "/api/v1/%2e%2e/accounts",
      "/api/accounts/",
      "/api/export/muny.json",
      "/%61pi/export/muny.json",
    ]) {
      const r = await app.inject({ method: "GET", url });
      expect([401, 404], url).toContain(r.statusCode);
      expect(r.body, url).not.toContain("Checking");
    }
  });
});
