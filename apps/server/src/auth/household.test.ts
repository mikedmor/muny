import { schema } from "@muny/db";
import type {
  Account,
  AuthStatusResponse,
  HouseholdInfo,
  InviteCreated,
  InviteStatus,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp, OWNER, TestClient } from "../test-utils.js";

const PARTNER = {
  email: "partner@example.com",
  password: "another long password",
  displayName: "Partner",
};

async function setup() {
  const ctx = await makeSignedInApp();
  const invite = async (role: "member" | "viewer") =>
    (await ctx.client.post("/api/household/invites", { role })).json<InviteCreated>();
  const join = async (inv: InviteCreated, who = PARTNER) => {
    const c = new TestClient(ctx.app);
    const r = await c.post(`/api/invites/${inv.token}/accept`, who);
    return { c, r };
  };
  return { ...ctx, invite, join };
}

describe("household", () => {
  it("invites a member who can then sign in and use Muny", async () => {
    const { client, db, invite, join } = await setup();
    const inv = await invite("member");
    expect(inv.path).toBe(`/invite/${inv.token}`);
    // Only the hash is stored.
    expect(JSON.stringify(db.select().from(schema.invites).all())).not.toContain(inv.token);

    const anon = new TestClient((await setup()).app);
    expect((await anon.get(`/api/invites/${inv.token}`)).json<InviteStatus>()).toEqual({
      valid: false,
    });
    const status = await (await join(inv)).c.get("/api/auth/status");
    expect(status.json<AuthStatusResponse>().user).toMatchObject({
      email: PARTNER.email,
      role: "member",
    });

    // Single use.
    const again = await join(inv, { ...PARTNER, email: "third@example.com" });
    expect(again.r.statusCode).toBe(404);

    const h = (await client.get("/api/household")).json<HouseholdInfo>();
    expect(h.users.map((u) => [u.email, u.role, u.isYou])).toEqual([
      [OWNER.email, "owner", true],
      [PARTNER.email, "member", false],
    ]);
    expect(h.invites).toEqual([]);
  });

  it("viewers can read but not change anything", async () => {
    const { client, invite, join } = await setup();
    await client.post("/api/accounts", { name: "Checking", type: "checking" });
    const { c } = await join(await invite("viewer"));
    expect((await c.get("/api/accounts")).json<Account[]>()).toHaveLength(1);
    const w = await c.post("/api/accounts", { name: "Nope", type: "checking" });
    expect(w.statusCode).toBe(403);
    expect(w.json().error).toMatch(/view-only/);
    expect(
      (
        await c.post("/api/auth/password", {
          currentPassword: PARTNER.password,
          newPassword: "a brand new password",
        })
      ).statusCode,
    ).toBe(200);
    expect((await c.post("/api/auth/logout")).statusCode).toBe(200);
  });

  it("household admin and backups are owner-only", async () => {
    const { client, invite, join } = await setup();
    const { c } = await join(await invite("member"));
    expect((await c.post("/api/household/invites", { role: "viewer" })).statusCode).toBe(403);
    expect((await c.get("/api/backups")).statusCode).toBe(403);
    expect((await c.get("/api/household")).json<HouseholdInfo>().invites).toEqual([]);

    const h = (await client.get("/api/household")).json<HouseholdInfo>();
    const partner = h.users.find((u) => !u.isYou);
    const me = h.users.find((u) => u.isYou);
    expect(
      (await client.patch(`/api/household/users/${me?.id}`, { role: "viewer" })).statusCode,
    ).toBe(400);
    await client.patch(`/api/household/users/${partner?.id}`, { role: "viewer" });
    expect((await c.post("/api/accounts", { name: "X", type: "checking" })).statusCode).toBe(403);

    expect((await client.delete(`/api/household/users/${partner?.id}`)).statusCode).toBe(200);
    expect((await c.get("/api/accounts")).statusCode).toBe(401);
  });

  it("revokes and expires invites", async () => {
    const { client, invite, join, db } = await setup();
    const a = await invite("member");
    expect((await client.get("/api/household")).json<HouseholdInfo>().invites).toHaveLength(1);
    await client.delete(`/api/household/invites/${a.id}`);
    expect((await join(a)).r.statusCode).toBe(404);

    const b = await invite("member");
    db.update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    expect((await join(b)).r.statusCode).toBe(404);
  });

  it("changing your password signs out your other sessions", async () => {
    const { app, client } = await setup();
    const other = new TestClient(app);
    await other.post("/api/auth/login", { email: OWNER.email, password: OWNER.password });
    expect((await other.get("/api/accounts")).statusCode).toBe(200);
    const wrong = await client.post("/api/auth/password", {
      currentPassword: "nope",
      newPassword: "a brand new password",
    });
    expect(wrong.statusCode).toBe(401);
    expect(
      (
        await client.post("/api/auth/password", {
          currentPassword: OWNER.password,
          newPassword: "a brand new password",
        })
      ).statusCode,
    ).toBe(200);
    expect((await client.get("/api/accounts")).statusCode).toBe(200);
    expect((await other.get("/api/accounts")).statusCode).toBe(401);
  });

  it("rejects a duplicate email", async () => {
    const { invite, join } = await setup();
    const r = (await join(await invite("member"), { ...PARTNER, email: OWNER.email })).r;
    expect(r.statusCode).toBe(409);
  });
});
