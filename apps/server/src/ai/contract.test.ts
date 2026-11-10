import { schema } from "@muny/db";
import type { ContractReviewState, DocumentInfo, LoansReport } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import {
  closeInterruptedReviews,
  locateQuote,
  makeBook,
  maskContract,
  splitParts,
} from "./contract.js";

// Synthetic only: a made-up contract and a fake model; nothing leaves the test.

const SECRET = Buffer.alloc(32, 7).toString("base64");
// biome-ignore lint/suspicious/noExplicitAny: provider wire format
type Body = Record<string, any>;

/** A PDF with one page per entry in `pages`, each a list of lines. */
function makePdf(pages: string[][]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const stream = lines
      .map((t, n) => `BT /F1 9 Tf 40 ${760 - n * 14} Td (${esc(t)}) Tj ET`)
      .join("\n");
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const contractPdf = makePdf([
  [
    "VACATION CLUB PURCHASE AND FINANCING AGREEMENT",
    "Buyer account 123456789 and social security number 123-45-6789.",
    "The amount financed is $21,500.00 at an annual percentage rate of 15.99 percent.",
    "Buyer may cancel this agreement without penalty by written notice",
    "mailed within seven days after the date of signing.",
  ],
  [
    "Buyer may prepay the balance in whole or in part at any time without penalty.",
    "Annual club dues may be increased by the association each year at its discretion.",
    "Any dispute shall be resolved by binding arbitration and Buyer waives class actions.",
  ],
  [""],
]);

const part = {
  findings: [
    {
      kind: "exit",
      title: "Seven days to cancel",
      quote:
        "Buyer may cancel this agreement without penalty by written notice mailed within seven days",
      explanation: "You could cancel in writing within a week of signing.",
      next_step: "Check the date you signed.",
    },
    {
      kind: "savings",
      title: "No prepayment penalty",
      quote: "may prepay the balance in whole or in part at any time without penalty",
      explanation: "Paying extra costs nothing.",
      next_step: null,
    },
    {
      kind: "exit",
      title: "An invented way out",
      quote: "Buyer may surrender the unit at any time and owe nothing further",
      explanation: "Sounds great, but it isn't there.",
    },
  ],
  terms: [
    {
      label: "Amount financed",
      value: "$21,500.00",
      quote: "The amount financed is $21,500.00",
    },
    { label: "Made-up term", value: "$1.00", quote: "this sentence is not in the contract at all" },
  ],
};
const final = {
  summary: "This commits you to about **fifteen** percent interest. Your cancel window has passed.",
  next_steps: ["Pay extra when you can."],
  questions: ["Is there a surrender program?"],
};
const ollama = (v: unknown) => ({ json: { message: { content: JSON.stringify(v) } } });
const good = (b: Body) =>
  b.messages[0].content.startsWith("You are reading") ? ollama(part) : ollama(final);

async function setup(
  reply: (body: Body, n: number) => { status?: number; json: unknown } = good,
  ai: Record<string, unknown> = { features: { contractReview: true } },
) {
  const sent: Body[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    sent.push(body);
    const r = reply(body, sent.length - 1);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const ctx = await makeSignedInApp({
    env: { MUNY_SECRET_KEY: SECRET },
    aiFetch: fetchFn,
    aiSleep: async () => {},
  });
  await ctx.client.put("/api/ai", {
    enabled: true,
    provider: "ollama",
    model: "sample-model",
    baseUrl: "http://ai.example.test",
    ...ai,
  });
  await ctx.client.post("/api/loans", {
    name: "Beach Club loan",
    kind: "other",
    lender: "Seaview Resorts",
    startBalanceCents: 1_800_000,
    startDate: "2026-01-01",
    aprBps: 1599,
    monthlyPaymentCents: 30_000,
    originalPrincipalCents: 2_150_000,
    originationDate: "2024-03-01",
    termMonths: 120,
  });
  const loan = (await ctx.client.get("/api/loans")).json<LoansReport>().loans[0] as {
    accountId: string;
  };
  const upload = async (pdf: Buffer = contractPdf, extra: Record<string, unknown> = {}) =>
    ctx.client
      .post("/api/documents", {
        name: "contract.pdf",
        mime: "application/pdf",
        dataBase64: pdf.toString("base64"),
        kind: "contract",
        accountId: loan.accountId,
        ...extra,
      })
      .then((r) => r.json<DocumentInfo>());
  const state = async (id: string) =>
    (await ctx.client.get(`/api/documents/${id}/review`)).json<ContractReviewState>();
  const finished = (id: string) =>
    vi.waitFor(
      async () => {
        const s = await state(id);
        if (s.status === "running") throw new Error("still running");
        return s;
      },
      { timeout: 5000, interval: 10 },
    );
  return { ...ctx, sent, upload, state, finished, loan };
}

describe("reading a contract", () => {
  it("hides identifying numbers", () => {
    expect(maskContract("SSN 123-45-6789, acct 123456789, card 4111 1111 1111 1111")).toBe(
      "SSN ###-##-####, acct #########, card #### #### #### ####",
    );
    expect(maskContract("$21,500.00 at 15.99% for 120 months")).toBe(
      "$21,500.00 at 15.99% for 120 months",
    );
  });

  it("finds quotes despite line breaks and hyphens, and only real ones", () => {
    const book = makeBook([
      "First page.",
      "The buyer may re-\nscind this agree-\nment “within seven days”.",
    ]);
    expect(locateQuote('may rescind this agreement "within seven days"', book)).toEqual({
      verified: true,
      page: 2,
    });
    expect(locateQuote("The buyer may ... within seven days", book).verified).toBe(false); // too short a piece
    expect(locateQuote("The buyer may rescind ... within seven days", book)).toEqual({
      verified: true,
      page: 2,
    });
    expect(locateQuote("may rescind this agreement within thirty days", book).verified).toBe(false);
    expect(locateQuote("seven", book).verified).toBe(false);
  });

  it("splits long contracts within the limit, labels pages and skips empty ones", () => {
    const parts = splitParts(["a ".repeat(2000), "", "b ".repeat(300)], 1000);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join(" ")).toContain("[Page 3]");
    expect(parts.join(" ")).not.toContain("[Page 2]");
  });
});

describe("contract review", () => {
  it("files a contract under its loan", async () => {
    const { upload, client } = await setup();
    const doc = await upload();
    expect(doc).toMatchObject({ kind: "contract", folder: "Contracts / Beach Club loan" });
    const bad = await client.post("/api/documents", {
      name: "x.pdf",
      mime: "application/pdf",
      dataBase64: contractPdf.toString("base64"),
      kind: "contract",
      accountId: "nope",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("is off until it's turned on, and sends nothing", async () => {
    const { upload, client, state, sent } = await setup(good, {});
    const doc = await upload();
    expect((await state(doc.id)).blockedBy).toContain("turned off");
    expect((await client.post(`/api/documents/${doc.id}/review`, {})).statusCode).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("reads it, checks every quote, and keeps the review encrypted", async () => {
    const { upload, client, finished, sent, db } = await setup();
    const doc = await upload();
    const started = await client.post(`/api/documents/${doc.id}/review`, {
      focus: "Can I cancel?",
    });
    expect(started.statusCode).toBe(200);
    const s = await finished(doc.id);
    expect(s.status).toBe("done");
    const r = s.result;
    if (!r) throw new Error("no result");

    // What went out: masked, with a context big enough, and the contract marked as data.
    const toModel = sent[0] as Body;
    expect(toModel.options.num_ctx).toBeGreaterThan(8000);
    const text = toModel.messages[1].content as string;
    expect(text).toContain("<contract>");
    expect(text).toContain("Can I cancel?");
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("123-45-6789");

    // The final step gets Muny's figures, and is told what couldn't be confirmed.
    const last = sent.at(-1) as Body;
    expect(last.messages[1].content).toContain("Interest rate on file: 15.99%");
    expect(last.messages[1].content).toContain("An invented way out");
    expect(last.messages[1].content).toContain("(UNCONFIRMED)");

    expect(r.summary).not.toContain("**");
    expect(r.pages).toBe(3);
    expect(r.unreadablePages).toEqual([3]);
    expect(r.findings.map((f) => [f.title, f.verified, f.page])).toEqual([
      ["Seven days to cancel", true, 1],
      ["No prepayment penalty", true, 2],
      ["An invented way out", false, null],
    ]);
    // A stated fact that can't be found isn't shown at all.
    expect(r.terms).toEqual([{ label: "Amount financed", value: "$21,500.00", page: 1 }]);
    expect(r.nextSteps).toEqual(["Pay extra when you can."]);

    const row = db.select().from(schema.documentReviews).get();
    expect(row?.encrypted).toBe(true);
    expect(row?.result).not.toContain("prepay");

    // Told when it's done, with nothing from the contract in the note.
    const note = db.select().from(schema.notifications).get();
    expect(note?.link).toBe(`/documents/${doc.id}/review`);
    expect(`${note?.title} ${note?.body}`).not.toMatch(/cancel|prepay|\$/i);

    // Not something to undo, and shown on the Documents list.
    expect(
      db.$client.prepare("select count(*) c from change_log where tbl = 'document_reviews'").get(),
    ).toEqual({ c: 0 });
    const docs = (await client.get("/api/documents")).json<DocumentInfo[]>();
    expect(docs[0]?.review).toBe("done");

    expect((await client.delete(`/api/documents/${doc.id}`)).statusCode).toBe(200);
    expect(db.select().from(schema.documentReviews).all()).toEqual([]);
  });

  it("says when a PDF is a scan, a picture or not a contract", async () => {
    const { upload, client, sent } = await setup();
    const scan = await upload(makePdf([[""], [""]]));
    const r = await client.post(`/api/documents/${scan.id}/review`, {});
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toMatch(/scan/);

    const plain = await client.post("/api/documents", {
      name: "other.pdf",
      mime: "application/pdf",
      dataBase64: makePdf([["Something else entirely, not a contract."]]).toString("base64"),
    });
    const other = await client.post(`/api/documents/${plain.json<DocumentInfo>().id}/review`, {});
    expect(other.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("asks again after an unusable answer, and says which pages it never got", async () => {
    const long = (w: string) => Array.from({ length: 40 }, () => `${w} `.repeat(40));
    const pdf = makePdf([
      long("alpha"),
      long("bravo"),
      long("charlie"),
      long("delta"),
      long("echo"),
      long("foxtrot"),
    ]);
    let badOnes = 0;
    const { upload, client, finished } = await setup((b) => {
      const prompt = b.messages[1].content as string;
      if (b.messages[0].content.startsWith("You are reading") && prompt.startsWith("Part 1 of")) {
        badOnes++;
        return { json: { message: { content: "not json at all" } } };
      }
      return good(b);
    });
    const doc = await upload(pdf);
    await client.post(`/api/documents/${doc.id}/review`, {});
    const s = await finished(doc.id);
    expect(badOnes).toBe(2);
    expect(s.status).toBe("done");
    expect(s.result?.skippedPages.length).toBeGreaterThan(0);
    expect(s.result?.skippedPages[0]).toBe(1);
  });

  it("keeps the last review when a new one fails, and says why", async () => {
    let down = false;
    const { upload, client, finished, db } = await setup((b) =>
      down ? { status: 404, json: { code: "model_unavailable" } } : good(b),
    );
    const doc = await upload();
    await client.post(`/api/documents/${doc.id}/review`, {});
    await finished(doc.id);
    down = true;
    await client.post(`/api/documents/${doc.id}/review`, {});
    const s = await finished(doc.id);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("sample-model");
    expect(s.result?.findings).toHaveLength(3);
    expect(
      db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.dedupeKey, `contract_review:${doc.id}`))
        .all(),
    ).toHaveLength(1);
  });

  it("marks a review cut short by a restart", async () => {
    const { upload, db, state } = await setup();
    const doc = await upload();
    db.insert(schema.documentReviews).values({ documentId: doc.id, status: "running" }).run();
    closeInterruptedReviews(db);
    const s = await state(doc.id);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("restarted");
  });
});
