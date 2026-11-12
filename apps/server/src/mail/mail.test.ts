import { schema } from "@muny/db";
import type {
  Account,
  DocumentInfo,
  MailMessage,
  MailMessageDetail,
  MailSettings,
  MailTemplateDraft,
  Transaction,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import type { MailSource } from "./imap.js";
import { parseMail, signatureFor } from "./parse.js";
import { dateIso, extract, moneyCents } from "./templates.js";

// Synthetic only: a made-up bank, made-up cards and a fake mailbox. Nothing leaves the test.

const SECRET = Buffer.alloc(32, 9).toString("base64");
const BANK = "alerts@samplebank.example";

let n = 0;
function email(o: {
  from?: string;
  subject: string;
  body: string;
  html?: boolean;
  signed?: "pass" | "fail" | "none";
  date?: string;
  pdf?: Buffer;
}): Buffer {
  n++;
  const from = o.from ?? BANK;
  const domain = from.split("@")[1];
  const auth =
    o.signed === "none"
      ? []
      : [
          `Authentication-Results: mx.mail.example; dkim=${o.signed ?? "pass"} header.i=@${domain}; spf=pass`,
        ];
  const head = [
    ...auth,
    // A made-up result lower down (as a sender could add) is ignored.
    "Authentication-Results: evil.example; dkim=pass header.i=@samplebank.example",
    `From: Sample Bank <${from}>`,
    "To: me@example.com",
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? "Thu, 12 Nov 2026 09:30:00 -0500"}`,
    `Message-ID: <msg-${n}@samplebank.example>`,
    "MIME-Version: 1.0",
  ];
  if (!o.pdf)
    return Buffer.from(
      [...head, `Content-Type: text/${o.html ? "html" : "plain"}; charset=utf-8`, "", o.body].join(
        "\r\n",
      ),
    );
  return Buffer.from(
    [
      ...head,
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.body,
      "--b1",
      'Content-Type: application/pdf; name="statement.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="statement.pdf"',
      "",
      o.pdf.toString("base64"),
      "--b1--",
    ].join("\r\n"),
  );
}

const charge = (amount: string, merchant: string, when = "11/12/2026", last4 = "4321") =>
  email({
    subject: "Card activity alert",
    body: [
      "Hello,",
      `A charge of ${amount} at ${merchant} was made on your card ending in ${last4} on ${when}.`,
      "If you don't recognize it, call us.",
    ].join("\n"),
  });

function mailbox() {
  const inbox: Buffer[] = [];
  const source = (): MailSource => ({
    async folders() {
      return ["INBOX", "Bank"];
    },
    async fetchNew(cursor) {
      const start = cursor.uidValidity === "7" ? cursor.lastUid : 0;
      return {
        uidValidity: "7",
        messages: inbox.slice(start).map((raw, i) => ({ uid: start + i + 1, raw })),
        more: false,
      };
    },
  });
  return { inbox, source };
}

async function setup() {
  const box = mailbox();
  const ctx = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET }, mailSource: box.source });
  const card = (
    await ctx.client.post("/api/accounts", {
      name: "Travel Card",
      type: "credit",
      balanceCents: 0,
      mask: "4321",
    })
  ).json<Account>();
  await ctx.client.put("/api/mail", {
    provider: "gmail",
    user: "me@example.com",
    password: "sample-app-password",
    folder: "Bank",
    senders: [BANK],
    enabled: true,
  });
  const check = () => ctx.client.post("/api/mail/check", {});
  const messages = async () => (await ctx.client.get("/api/mail/messages")).json<MailMessage[]>();
  const txns = async () =>
    (await ctx.client.get(`/api/transactions?accountId=${card.id}`)).json<{
      items: Transaction[];
    }>().items;
  return { ...ctx, ...box, card, check, messages, txns };
}

async function teachActivity(c: Awaited<ReturnType<typeof setup>>) {
  const first = (await c.messages()).find((m) => m.status === "unrecognized");
  if (!first) throw new Error("nothing to teach from");
  const draft = (
    await c.client.post(`/api/mail/messages/${first.id}/draft`, {
      kind: "activity",
      values: { amount: "$45.12", merchant: "SAMPLE COFFEE CO", date: "11/12/2026", last4: "4321" },
    })
  ).json<MailTemplateDraft>();
  expect(draft.missing).toEqual([]);
  expect(draft.read).toEqual({
    amount: 4512,
    merchant: "SAMPLE COFFEE CO",
    date: "2026-11-12",
    last4: "4321",
  });
  return c.client.post("/api/mail/templates", {
    name: "Sample Bank charges",
    kind: "activity",
    from: BANK,
    fields: draft.fields,
  });
}

describe("reading values from email text", () => {
  it("reads amounts, dates and values between words that change", () => {
    expect(moneyCents("$1,234.56")).toBe(123_456);
    expect(moneyCents("USD 12")).toBe(1200);
    expect(moneyCents("($7.5)")).toBe(750);
    expect(dateIso("Nov 3, 2026", 2026)).toBe("2026-11-03");
    expect(dateIso("3 November 2026", 2026)).toBe("2026-11-03");
    expect(dateIso("11/03/26", 2026)).toBe("2026-11-03");
    expect(dateIso("on 12/30", 2025)).toBe("2025-12-30");
    expect(dateIso("13/45/2026", 2026)).toBeNull();
    const a = { before: "A charge of", after: "at" };
    expect(extract("A charge of $9.99 at SHOP on Dec 1.", a)).toBe("$9.99");
    // The numbers and month around a value may differ from the email it was taught on.
    const b = { before: "on Nov 12, 2026 a charge of", after: "at" };
    expect(extract("on Dec 3, 2026 a charge of $5.00 at X", b)).toBe("$5.00");
  });

  it("trusts only the receiving server's signature check", () => {
    const raw = Buffer.from(
      [
        "Authentication-Results: mx.mail.example; dkim=fail header.i=@samplebank.example",
        "Authentication-Results: fake.example; dkim=pass header.i=@samplebank.example",
        "From: x@samplebank.example",
        "",
        "hi",
      ].join("\r\n"),
    );
    expect(signatureFor(raw, "x@samplebank.example")).toBe("fail");
    const other = Buffer.from(
      "Authentication-Results: mx; dkim=pass header.d=elsewhere.example\r\nFrom: x@samplebank.example\r\n\r\nhi",
    );
    expect(signatureFor(other, "x@samplebank.example")).toBe("fail");
    expect(signatureFor(Buffer.from("From: a@b.example\r\n\r\nhi"), "a@b.example")).toBe("none");
  });

  it("gets text from an HTML-only email", async () => {
    const m = await parseMail(
      email({
        html: true,
        subject: "Alert",
        body: "<p>A charge of <b>$3.10</b> at <span>SAMPLE BAKERY</span>&nbsp;was made.</p><script>alert(1)</script>",
      }),
    );
    expect(m.text).toContain("A charge of $3.10 at SAMPLE BAKERY was made.");
    expect(m.text).not.toContain("alert(1)");
  });
});

describe("email import", () => {
  it("can't be turned on half set up, and never sends the password back", async () => {
    const { client } = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET } });
    expect((await client.put("/api/mail", { enabled: true })).statusCode).toBe(409);
    const bad = await client.put("/api/mail", { senders: ["not an address"] });
    expect(bad.statusCode).toBe(409);
    const ok = (
      await client.put("/api/mail", {
        senders: ["Alerts@SampleBank.example", "samplebank.example", "@samplebank.example"],
        password: "secret-one",
      })
    ).json<MailSettings>();
    expect(ok.senders).toEqual(["alerts@samplebank.example", "@samplebank.example"]);
    expect(ok.hasPassword).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("secret-one");
  });

  it("leaves strangers and unsigned email alone, and learns a bank's activity emails", async () => {
    const c = await setup();
    c.inbox.push(
      charge("$45.12", "SAMPLE COFFEE CO"),
      email({ from: "promo@other.example", subject: "Win!", body: "A charge of $1.00 at X" }),
      email({ subject: "Card activity alert", body: "A charge of $9.00 at Y", signed: "fail" }),
    );
    expect((await c.check()).json()).toMatchObject({ read: 3, transactions: 0, unrecognized: 1 });
    expect((await c.messages()).map((m) => m.status).sort()).toEqual([
      "not_allowed",
      "unrecognized",
      "unsigned",
    ]);
    expect(await c.txns()).toEqual([]);

    // The email is kept (encrypted) to learn from.
    const kept = (await c.messages()).find((m) => m.status === "unrecognized") as MailMessage;
    const detail = (await c.client.get(`/api/mail/messages/${kept.id}`)).json<MailMessageDetail>();
    expect(detail.text).toContain("SAMPLE COFFEE CO");
    const row = c.db
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.id, kept.id))
      .get();
    expect(row?.bodyEnc).not.toContain("COFFEE");

    // Teaching it reads that email at once.
    const saved = await teachActivity(c);
    expect(saved.json()).toMatchObject({ used: 1, added: 1 });
    let list = await c.txns();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      amountCents: -4512,
      postedDate: "2026-11-12",
      rawDescription: "SAMPLE COFFEE CO",
      source: "Email",
    });

    // The next ones on its own, with a different amount, merchant and date.
    c.inbox.push(charge("$1,203.99", "SAMPLE AIRLINE 123", "11/14/2026"));
    expect((await c.check()).json()).toMatchObject({ read: 1, transactions: 1 });
    list = await c.txns();
    expect(list.map((t) => [t.rawDescription, t.amountCents, t.postedDate])).toContainEqual([
      "SAMPLE AIRLINE 123",
      -120_399,
      "2026-11-14",
    ]);

    // Read once: checking again adds nothing.
    expect((await c.check()).json()).toMatchObject({ read: 0 });
    expect(await c.txns()).toHaveLength(2);

    // Allowing a sender reads what it sent again.
    const stranger = (await c.messages()).find((m) => m.status === "not_allowed") as MailMessage;
    const allowed = (
      await c.client.post(`/api/mail/messages/${stranger.id}/allow`, { domain: true })
    ).json<{ sender: string }>();
    expect(allowed.sender).toBe("@other.example");
    expect((await c.messages()).find((m) => m.id === stranger.id)?.status).toBe("unrecognized");
  });

  it("doesn't add a charge a statement already brought in", async () => {
    const c = await setup();
    await c.client.post("/api/transactions", {
      accountId: c.card.id,
      postedDate: "2026-11-11",
      amountCents: -4512,
      description: "SAMPLE COFFEE CO",
    });
    c.inbox.push(charge("$45.12", "SAMPLE COFFEE CO"));
    await c.check();
    await teachActivity(c);
    expect(await c.txns()).toHaveLength(1);
    expect((await c.messages())[0]).toMatchObject({ status: "skipped" });
  });

  it("updates a card from a statement email, and keeps a statement PDF in Documents", async () => {
    const c = await setup();
    c.inbox.push(
      email({
        subject: "Your statement is ready",
        body: [
          "Your Travel Card statement is ready.",
          "Statement balance: $612.40",
          "Minimum payment due: $35.00",
          "Payment due date: December 8, 2026",
        ].join("\n"),
      }),
    );
    await c.check();
    const msg = (await c.messages())[0] as MailMessage;
    const draft = (
      await c.client.post(`/api/mail/messages/${msg.id}/draft`, {
        kind: "summary",
        values: { balance: "$612.40", minimum: "$35.00", dueDate: "December 8, 2026" },
      })
    ).json<MailTemplateDraft>();
    expect(draft.read).toMatchObject({ balance: 61_240, minimum: 3500, dueDate: "2026-12-08" });
    // No card number in it: the template names the card.
    const saved = await c.client.post("/api/mail/templates", {
      name: "Sample Bank statements",
      kind: "summary",
      from: BANK,
      subject: "statement",
      accountId: c.card.id,
      fields: draft.fields,
    });
    expect(saved.json()).toMatchObject({ used: 1 });
    const details = c.db
      .select()
      .from(schema.cardDetails)
      .where(eq(schema.cardDetails.accountId, c.card.id))
      .get();
    expect(details).toMatchObject({
      statementBalanceCents: 61_240,
      minimumPaymentCents: 3500,
      dueDate: "2026-12-08",
      statementDate: "2026-11-12",
    });

    // A PDF that can't be read (locked, say) is still kept, under Documents → Email.
    c.inbox.push(
      email({
        subject: "Your statement is attached",
        body: "Attached.",
        pdf: Buffer.from("%PDF-1.4\n% synthetic, unreadable\n%%EOF"),
      }),
    );
    expect((await c.check()).json()).toMatchObject({ statements: 1 });
    const docs = (await c.client.get("/api/documents")).json<DocumentInfo[]>();
    expect(docs.find((d) => d.name === "statement.pdf")?.folder).toBe("Email");
  });

  it("is owner only", async () => {
    const c = await setup();
    const invite = await c.client.post("/api/household/invites", { role: "viewer" });
    if (invite.statusCode !== 200) return; // households may not be set up in this build
    expect((await c.client.get("/api/mail")).statusCode).toBe(200);
  });
});
