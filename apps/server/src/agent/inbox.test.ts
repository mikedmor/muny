import { schema } from "@muny/db";
import {
  type Account,
  AGENT_SCOPES,
  type AgentScope,
  type CategoryGroup,
  type CreatedApiToken,
  type ProposalDecision,
  type ProposalList,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp, TestClient } from "../test-utils.js";
import { PROPOSAL_TOOLS } from "./proposals.js";
import { TOOLS } from "./tools.js";

// Synthetic data only.

async function setup(scopes: AgentScope[] = [...AGENT_SCOPES]) {
  const ctx = await makeSignedInApp();
  const { client, app, db } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const categoryId = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
  const acc = (
    await client.post("/api/accounts", {
      name: "Everyday",
      type: "checking",
      balanceCents: 500_000,
    })
  ).json<Account>();
  const add = async (description: string, amountCents = -4218) =>
    (
      await client.post("/api/transactions", {
        accountId: acc.id,
        postedDate: localToday(),
        amountCents,
        description,
      })
    ).json<{ id: string }>().id;
  const token = (
    await client.post("/api/agents/tokens", { name: "Claude", scopes, expiresInDays: null })
  ).json<CreatedApiToken>();
  const call = (name: string, input: unknown = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/tools/${name}`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: input as object,
    });
  const inbox = async () => (await client.get("/api/proposals")).json<ProposalList>();
  const decide = async (ids: string[], decision: "approve" | "reject") =>
    (await client.post("/api/proposals/decide", { ids, decision })).json<ProposalDecision[]>();
  const categoryOf = (id: string) =>
    db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()?.categoryId;
  return { ...ctx, categoryId, acc, add, token, call, inbox, decide, categoryOf };
}

describe("the approval inbox", () => {
  it("changes nothing until approved, and shows what Muny worked out", async () => {
    const { add, call, inbox, decide, categoryOf, categoryId } = await setup();
    const id = await add("CORNER MARKET");

    const dry = (
      await call("categorize_transactions", { transaction_ids: [id], category: "Groceries" })
    ).json();
    expect(dry.dryRun).toBe(true);
    expect((await inbox()).pending).toEqual([]);

    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        reason: "Looks like food.",
        dry_run: false,
      })
    ).json();
    expect(filed.filed).toBe(true);
    expect(categoryOf(id)).toBeNull();

    const { pending } = await inbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tokenName: "Claude",
      summary: "Put 1 transaction in Groceries",
      reason: "Looks like food.",
      status: "pending",
    });
    expect(pending[0]?.changes[0]).toMatchObject({ from: "Uncategorized", to: "Groceries" });

    const [decision] = await decide([filed.id], "approve");
    expect(decision?.status).toBe("approved");
    expect(categoryOf(id)).toBe(categoryId("Groceries"));
    const after = await inbox();
    expect(after.pending).toEqual([]);
    expect(after.recent[0]?.status).toBe("approved");
  });

  it("does nothing on a rejection, and tells the assistant", async () => {
    const { add, call, decide, categoryOf } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();
    await decide([filed.id], "reject");
    expect(categoryOf(id)).toBeNull();
    const seen = (await call("list_proposals")).json();
    expect(seen[0]).toMatchObject({ id: filed.id, status: "rejected" });
  });

  it("refuses to apply when things changed after it was suggested", async () => {
    const { add, call, decide, categoryOf, categoryId, client, inbox } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();
    await client.patch(`/api/transactions/${id}`, { categoryId: categoryId("Dining & Drinks") });
    const [decision] = await decide([filed.id], "approve");
    expect(decision?.status).toBe("failed");
    expect(decision?.result).toContain("changed since");
    expect(categoryOf(id)).toBe(categoryId("Dining & Drinks"));
    expect((await inbox()).recent[0]?.status).toBe("failed");
  });

  it("can't be decided twice", async () => {
    const { add, call, decide, categoryOf, client, categoryId } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();
    await decide([filed.id], "approve");
    await client.patch(`/api/transactions/${id}`, { categoryId: categoryId("Dining & Drinks") });
    const [again] = await decide([filed.id], "approve");
    expect(again?.status).toBe("approved");
    expect(categoryOf(id)).toBe(categoryId("Dining & Drinks"));
  });

  it("doesn't file the same thing twice, or things that are already so", async () => {
    const { add, call, inbox, categoryId, client } = await setup();
    const id = await add("CORNER MARKET");
    const input = { transaction_ids: [id], category: "Groceries", dry_run: false };
    const a = (await call("categorize_transactions", input)).json();
    const b = (await call("categorize_transactions", input)).json();
    expect(b.id).toBe(a.id);
    expect((await inbox()).pending).toHaveLength(1);

    await client.patch(`/api/transactions/${id}`, { categoryId: categoryId("Dining & Drinks") });
    const none = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Dining & Drinks",
        dry_run: false,
      })
    ).json();
    expect(none.filed).toBe(false);
  });

  it("expires old suggestions", async () => {
    const { db, add, call, inbox, decide, categoryOf } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();
    db.update(schema.agentProposals)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .run();
    expect((await inbox()).pending).toEqual([]);
    expect((await inbox()).recent[0]?.status).toBe("expired");
    await decide([filed.id], "approve");
    expect(categoryOf(id)).toBeNull();
  });

  it("gives clear refusals for what doesn't exist", async () => {
    const { add, call } = await setup();
    const id = await add("CORNER MARKET");
    const noCat = await call("categorize_transactions", {
      transaction_ids: [id],
      category: "Nope",
    });
    expect(noCat.statusCode).toBe(400);
    expect(noCat.json().error.message).toContain("no category");
    const noTxn = await call("categorize_transactions", {
      transaction_ids: ["nope"],
      category: "Groceries",
    });
    expect(noTxn.json().error.message).toContain("don't exist");
  });

  it("lets assistants read the ids these tools need", async () => {
    const { add, call } = await setup();
    const id = await add("CORNER MARKET");
    const found = (await call("search_transactions", { text: "corner" })).json();
    expect(found[0]?.id).toBe(id);
  });

  it("applies each kind of change", async () => {
    const { db, add, call, decide, client, categoryId, acc } = await setup();
    const a = await add("CORNER MARKET");
    const b = await add("NOODLE BAR");
    const file = async (tool: string, input: object) => {
      const res = await call(tool, { ...input, dry_run: false });
      expect(res.statusCode, `${tool}: ${res.body}`).toBe(200);
      const out = res.json();
      expect(out.filed, tool).toBe(true);
      const [d] = await decide([out.id], "approve");
      expect(d?.status, `${tool}: ${d?.result}`).toBe("approved");
    };

    await file("tag_transactions", { transaction_ids: [a, b], tag: "review" });
    const tagged = db.select().from(schema.transactionTags).all();
    expect(tagged).toHaveLength(2);

    await file("add_transaction_note", { transaction_id: a, note: "Sample note" });
    expect(
      db.select().from(schema.transactions).where(eq(schema.transactions.id, a)).get()?.notes,
    ).toBe("Sample note");

    await file("set_budget", { category: "Groceries", amount_cents: 50_000 });
    expect(db.select().from(schema.budgets).all()).toHaveLength(1);

    // Rules skip hand-entered transactions, as they do for anything edited by hand.
    db.update(schema.transactions).set({ userModified: false }).run();
    await file("create_rule", {
      name: "Noodles",
      conditions: [
        { field: "description", op: "contains", value: "noodle" },
        { field: "account", value: "Everyday" },
      ],
      actions: [{ type: "setCategory", category: "Dining & Drinks" }],
      apply_to_existing: true,
    });
    expect(db.select().from(schema.rules).all()).toHaveLength(1);
    expect(
      db.select().from(schema.transactions).where(eq(schema.transactions.id, b)).get()?.categoryId,
    ).toBe(categoryId("Dining & Drinks"));

    const series = (
      await client.post("/api/recurring", {
        transactionId: a,
        kind: "subscription",
        interval: "monthly",
      })
    ).json<{ id: string }>();
    await file("confirm_subscription", { series_id: series.id, status: "ignored" });
    expect(db.select().from(schema.recurringSeries).all()[0]?.status).toBe("ignored");

    await file("propose_savings_action", {
      kind: "cancelled",
      name: "Old gym",
      before_monthly_cents: 3000,
    });
    expect(db.select().from(schema.savings).all()).toHaveLength(1);

    await file("create_replacement_plan", { service_name: "Cloud photos", alternative: "Immich" });
    expect(db.select().from(schema.diyProjects).all()).toHaveLength(1);
    expect(acc.id).toBeTruthy();
  });

  it("files a rule even when nothing matches yet", async () => {
    const { call } = await setup();
    const out = (
      await call("create_rule", {
        name: "Future",
        conditions: [{ field: "description", op: "contains", value: "not here yet" }],
        actions: [{ type: "addTag", name: "later" }],
        dry_run: false,
      })
    ).json();
    expect(out.filed).toBe(true);
  });

  it("applies each scope only to its own tools", async () => {
    const { call } = await setup(["read:summary"]);
    for (const tool of PROPOSAL_TOOLS)
      expect((await call(tool.name, {})).statusCode, tool.name).toBe(403);
  });

  it("has no other way to change financial data", () => {
    const filed = new Set(PROPOSAL_TOOLS.map((t) => t.name));
    for (const t of TOOLS.filter((x) => x.write))
      expect(t.scope === "write:dashboard" || filed.has(t.name), t.name).toBe(true);
    // Nothing that deletes or moves money, by name.
    const names = TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/transfer|delete_transaction|delete_account|credential|token/);
  });

  it("is for people who can change things, and an assistant can't approve its own", async () => {
    const { client, app, add, call, token } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();

    const invite = await client.post("/api/household/invites", { role: "viewer" });
    const viewer = new TestClient(app);
    await viewer.post(`/api/invites/${invite.json<{ token: string }>().token}/accept`, {
      email: "viewer@example.com",
      password: "correct horse battery",
    });
    expect((await viewer.get("/api/proposals")).statusCode).toBe(200);
    expect(
      (await viewer.post("/api/proposals/decide", { ids: [filed.id], decision: "approve" }))
        .statusCode,
    ).toBe(403);

    const bearer = await app.inject({
      method: "POST",
      url: "/api/proposals/decide",
      headers: { authorization: `Bearer ${token.token}`, "x-muny-csrf": "1" },
      payload: { ids: [filed.id], decision: "approve" },
    });
    expect(bearer.statusCode).toBe(401);
  });

  it("gives one heads-up that says nothing about your money", async () => {
    const { db, add, call } = await setup();
    const a = await add("SECRET-SOUNDING MERCHANT");
    const b = await add("ANOTHER MERCHANT");
    await call("categorize_transactions", {
      transaction_ids: [a],
      category: "Groceries",
      dry_run: false,
    });
    await call("categorize_transactions", {
      transaction_ids: [b],
      category: "Groceries",
      dry_run: false,
    });
    const sent = db
      .select()
      .from(schema.notifications)
      .all()
      .filter((n) => n.ruleType === "agent_proposal");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.link).toBe("/alerts#inbox");
    expect(JSON.stringify(sent)).not.toContain("MERCHANT");
    expect(JSON.stringify(sent)).not.toContain("Groceries");
  });

  it("audits who decided", async () => {
    const { db, add, call, decide } = await setup();
    const id = await add("CORNER MARKET");
    const filed = (
      await call("categorize_transactions", {
        transaction_ids: [id],
        category: "Groceries",
        dry_run: false,
      })
    ).json();
    await decide([filed.id], "approve");
    const entry = db
      .select()
      .from(schema.auditLog)
      .all()
      .find((r) => r.action === "proposal.approve");
    expect(entry?.actorType).toBe("user");
    expect(entry?.details).toMatchObject({ tool: "categorize_transactions", status: "approved" });
  });
});
