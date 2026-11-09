import { schema } from "@muny/db";
import {
  type Account,
  type CategoryGroup,
  CHANGE_HEADER,
  CHANGE_TITLE_HEADER,
  type ChangeList,
  type ProposalList,
  type Rule,
  type Transaction,
  type UndoPreview,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { fileFromMuny } from "../agent/proposals.js";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { openChange, runAsChange } from "./track.js";

// Synthetic data only.

async function setup() {
  const ctx = await makeSignedInApp();
  const { client } = ctx;
  const acc = (
    await client.post("/api/accounts", { name: "Sample Checking", type: "checking" })
  ).json<Account>();
  const cats = (await client.get("/api/categories"))
    .json<CategoryGroup[]>()
    .flatMap((g) => g.categories);
  const cat = (name: string) => cats.find((c) => c.name === name)?.id as string;
  const txn = (
    await client.post("/api/transactions", {
      accountId: acc.id,
      postedDate: localToday(),
      amountCents: -450,
      description: "CORNER CAFE",
    })
  ).json<Transaction>();
  const history = async () => (await ctx.client.get("/api/changes")).json<ChangeList>().items;
  const categoryOf = async () =>
    (await client.get(`/api/transactions/${txn.id}`)).json<Transaction>().categoryId;
  return { ...ctx, acc, txn, cat, history, categoryOf };
}

describe("undo", () => {
  it("offers to undo an edit, puts it back, and redoes it", async () => {
    const { client, txn, cat, history, categoryOf } = await setup();
    const res = await client.patch(`/api/transactions/${txn.id}`, { categoryId: cat("Coffee") });
    const id = res.headers[CHANGE_HEADER] as string;
    expect(id).toBeTruthy();
    expect(decodeURIComponent(res.headers[CHANGE_TITLE_HEADER] as string)).toBe(
      "Changed transaction “CORNER CAFE”",
    );
    const [latest] = await history();
    expect(latest).toMatchObject({ id, parts: ["1 transaction changed"], undone: false });

    const undo = await client.post(`/api/changes/${id}/undo`, {});
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ title: "Undid: Changed transaction “CORNER CAFE”" });
    // An undo isn't itself offered straight away: the page offers Redo.
    expect(undo.headers[CHANGE_HEADER]).toBeUndefined();
    expect(await categoryOf()).toBeNull();
    expect((await history()).find((c) => c.id === id)?.undone).toBe(true);

    // Twice is refused.
    expect((await client.post(`/api/changes/${id}/undo`, {})).statusCode).toBe(422);

    // Undoing the undo redoes it.
    const redo = await client.post(`/api/changes/${undo.json<{ id: string }>().id}/undo`, {});
    expect(redo.json()).toMatchObject({ title: "Redid: Changed transaction “CORNER CAFE”" });
    expect(await categoryOf()).toBe(cat("Coffee"));
    expect((await history()).find((c) => c.id === id)?.undone).toBe(false);
  });

  it("brings back something deleted, with the same id", async () => {
    const { client, cat } = await setup();
    const rule = (
      await client.post("/api/rules", {
        name: "Cafe",
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "CAFE" }],
        actions: [{ type: "setCategory", categoryId: cat("Coffee") }],
      })
    ).json<Rule>();
    const del = await client.delete(`/api/rules/${rule.id}`);
    expect(decodeURIComponent(del.headers[CHANGE_TITLE_HEADER] as string)).toBe(
      "Removed rule “Cafe”",
    );
    await client.post(`/api/changes/${del.headers[CHANGE_HEADER]}/undo`, {});
    const rules = (await client.get("/api/rules")).json<Rule[]>();
    expect(rules.find((r) => r.id === rule.id)?.name).toBe("Cafe");
  });

  it("asks first when it was changed since, and only puts back what it changed", async () => {
    const { client, txn, cat, categoryOf } = await setup();
    const first = await client.patch(`/api/transactions/${txn.id}`, {
      categoryId: cat("Coffee"),
    });
    // A later edit to another field doesn't stand in the way.
    await client.patch(`/api/transactions/${txn.id}`, { notes: "with a friend" });
    const id = first.headers[CHANGE_HEADER] as string;
    const clean = (await client.get(`/api/changes/${id}/preview`)).json<UndoPreview>();
    expect(clean).toMatchObject({ conflictCount: 0, extra: false, error: null });

    await client.patch(`/api/transactions/${txn.id}`, { categoryId: cat("Groceries") });
    const asked = await client.post(`/api/changes/${id}/undo`, {});
    expect(asked.statusCode).toBe(409);
    expect(asked.json<{ details: UndoPreview }>().details).toMatchObject({
      conflicts: ["Transaction “CORNER CAFE” was changed afterwards."],
      effects: ["1 transaction changed back"],
    });
    expect(await categoryOf()).toBe(cat("Groceries"));

    expect((await client.post(`/api/changes/${id}/undo`, { force: true })).statusCode).toBe(200);
    expect(await categoryOf()).toBeNull();
    const notes = (await client.get(`/api/transactions/${txn.id}`)).json<Transaction>().notes;
    expect(notes).toBe("with a friend");
  });

  it("says what else would go, like an account's transactions", async () => {
    const { client, db } = await setup();
    const made = await client.post("/api/accounts", { name: "Sample Savings", type: "savings" });
    const acc = made.json<Account>();
    await client.post("/api/transactions", {
      accountId: acc.id,
      postedDate: localToday(),
      amountCents: 10_000,
      description: "SAMPLE DEPOSIT",
    });
    const id = made.headers[CHANGE_HEADER] as string;
    const asked = await client.post(`/api/changes/${id}/undo`, {});
    expect(asked.statusCode).toBe(409);
    const preview = asked.json<{ details: UndoPreview }>().details;
    expect(preview.extra).toBe(true);
    expect(preview.effects).toEqual(
      expect.arrayContaining(["1 account removed", "1 transaction removed"]),
    );
    // Nothing happened yet.
    expect(
      db.select().from(schema.accounts).where(eq(schema.accounts.id, acc.id)).get(),
    ).toBeTruthy();

    await client.post(`/api/changes/${id}/undo`, { force: true });
    expect(
      db.select().from(schema.accounts).where(eq(schema.accounts.id, acc.id)).get(),
    ).toBeUndefined();
  });

  it("keeps quiet about arranging, and never records passwords or counters", async () => {
    const { client, db } = await setup();
    const ui = await client.put("/api/settings/ui", { splitCharts: true });
    expect(ui.headers[CHANGE_HEADER]).toBeUndefined();
    const pw = await client.post("/api/auth/password", {
      currentPassword: "correct horse battery",
      newPassword: "another horse battery",
    });
    expect(pw.headers[CHANGE_HEADER]).toBeUndefined();
    const id = openChange(db, { actorType: "system" });
    runAsChange(id, () =>
      db.$client
        .prepare("insert into app_settings (key, value) values ('crypto.usage', '{}')")
        .run(),
    );
    expect(
      db.select().from(schema.changeLog).where(eq(schema.changeLog.changesetId, id)).all(),
    ).toEqual([]);
  });

  it("puts back files (blobs) byte for byte", async () => {
    const { client, db } = await setup();
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const id = openChange(db, { actorType: "system" });
    db.insert(schema.documents)
      .values({
        id: "doc-1",
        name: "sample.pdf",
        mime: "application/pdf",
        sizeBytes: 5,
        sha256: "abc",
        data: bytes,
      })
      .run();
    runAsChange(id, () =>
      db.delete(schema.documents).where(eq(schema.documents.id, "doc-1")).run(),
    );
    expect((await client.post(`/api/changes/${id}/undo`, {})).statusCode).toBe(200);
    const back = db.select().from(schema.documents).where(eq(schema.documents.id, "doc-1")).get();
    expect(back?.data.equals(bytes)).toBe(true);
  });

  it("names an inbox decision by what was approved, and undoes all of it", async () => {
    const { client, db, txn, cat, categoryOf } = await setup();
    fileFromMuny(
      db,
      localToday(),
      "categorize_transactions",
      { transaction_ids: [txn.id], category: cat("Coffee") },
      "Sample suggestion.",
    );
    const [item] = (await client.get("/api/proposals")).json<ProposalList>().pending;
    const r = await client.post("/api/proposals/decide", {
      ids: [item?.id],
      decision: "approve",
    });
    expect(decodeURIComponent(r.headers[CHANGE_TITLE_HEADER] as string)).toBe(
      "Approved “Put 1 transaction in Coffee”",
    );
    expect(await categoryOf()).toBe(cat("Coffee"));
    await client.post(`/api/changes/${r.headers[CHANGE_HEADER]}/undo`, {});
    expect(await categoryOf()).toBeNull();
    // Back in the inbox, to decide again.
    expect((await client.get("/api/proposals")).json<ProposalList>().pending).toHaveLength(1);
  });
});
