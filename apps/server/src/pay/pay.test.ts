import { newId, schema } from "@muny/db";
import type { DocumentInfo, PayUploadResult, PayYear } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { TOOL_MAP } from "../agent/tools.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic only: a made-up employer, person, accounts and amounts.

const SECRET = Buffer.alloc(32, 9).toString("base64");

type Cell = { x: number; y: number; t: string };

/** A one-page PDF with text at positions (Helvetica 9pt). */
function makePdf(cells: Cell[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = cells.map((c) => `BT /F1 9 Tf ${c.x} ${c.y} Td (${esc(c.t)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

/** Helvetica 9pt widths of what ADP amounts are made of. */
const w = (s: string) => [...s].reduce((t, c) => t + (c === "-" ? 3 : c === "*" ? 3.5 : 5), 0);

/** An ADP amount: digit groups right-aligned to `right`, 5 points apart. */
function adp(text: string, right: number, y: number): Cell[] {
  const m = text.match(/^([-$]*)([\d,]+)\.(\d{2})(\*?)$/) as RegExpMatchArray;
  const groups = (m[2] as string).split(",");
  groups[0] = `${m[1]}${groups[0]}`;
  const out: Cell[] = [];
  let r = right;
  for (const p of [...groups, `${m[3]}${m[4]}`].reverse()) {
    out.push({ x: r - w(p), y, t: p });
    r = r - w(p) - 5;
  }
  return out;
}

function stubPdf(payDate: string, medical = "-50.00*"): Buffer {
  return makePdf([
    { x: 350, y: 759, t: "Earnings Statement" },
    { x: 100, y: 736, t: "NORTHWIND PARTS LLC" },
    { x: 354, y: 736, t: "Period Beginning:" },
    { x: 455, y: 736, t: "01/01/2026" },
    { x: 354, y: 724, t: "Period Ending:" },
    { x: 455, y: 724, t: "01/07/2026" },
    { x: 354, y: 712, t: "Pay Date:" },
    { x: 455, y: 712, t: payDate },
    { x: 212, y: 600, t: "this period" },
    { x: 282, y: 600, t: "year to date" },
    { x: 21, y: 587, t: "Regular" },
    ...adp("1,000.00", 256, 587),
    ...adp("1,000.00", 336, 587),
    { x: 95, y: 563, t: "Gross Pay" },
    ...adp("$1,000.00", 256, 563),
    ...adp("1,000.00", 336, 563),
    { x: 95, y: 533, t: "Statutory" },
    { x: 95, y: 521, t: "Federal Income Tax" },
    ...adp("-100.00", 256, 521),
    ...adp("100.00", 336, 521),
    { x: 95, y: 509, t: "Social Security Tax" },
    ...adp("-62.00", 256, 509),
    ...adp("62.00", 336, 509),
    { x: 95, y: 479, t: "Medical" },
    ...adp(medical, 260, 479),
    ...adp("50.00", 336, 479),
    { x: 95, y: 461, t: "Net Pay" },
    ...adp("$788.00", 256, 461),
    { x: 95, y: 449, t: "Checking" },
    ...adp("-788.00", 256, 449),
    { x: 95, y: 431, t: "Net Check" },
    ...adp("$0.00", 256, 431),
    { x: 350, y: 130, t: "xxxxx4321" },
    ...adp("$788.00", 587, 130),
  ]);
}

function w2Pdf(): Buffer {
  return makePdf([
    { x: 281, y: 772, t: "2025 W-2 and EARNINGS SUMMARY" },
    { x: 20, y: 570, t: "Wages, tips, other comp." },
    { x: 130, y: 570, t: "Federal income tax withheld" },
    { x: 58, y: 560, t: "49400.00" },
    { x: 165, y: 560, t: "5000.00" },
    { x: 20, y: 470, t: "DD" },
    { x: 60, y: 470, t: "15000.00" },
  ]);
}

async function setup() {
  const ctx = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET } });
  const account = newId();
  ctx.db
    .insert(schema.accounts)
    .values({ id: account, name: "Everyday Checking", type: "checking", mask: "4321" })
    .run();
  ctx.db
    .insert(schema.transactions)
    .values({
      id: "deposit-1",
      accountId: account,
      postedDate: "2026-01-14",
      amountCents: 78_800,
      rawDescription: "NORTHWIND PAYROLL",
      importHash: "h1",
    })
    .run();
  const upload = (pdf: Buffer, filename = "stub.pdf") =>
    ctx.client.post("/api/pay/documents", { filename, base64: pdf.toString("base64") });
  return { ...ctx, upload };
}

describe("pay", () => {
  it("reads a pay stub, matches its deposit and builds the year", async () => {
    const { client, upload } = await setup();
    const res = await upload(stubPdf("01/13/2026"));
    expect(res.statusCode).toBe(200);
    expect(res.json<PayUploadResult[]>()).toEqual([
      expect.objectContaining({ kind: "stub", label: "Pay stub for Jan 13, 2026", problems: [] }),
    ]);

    const again = await upload(stubPdf("01/13/2026"));
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/already added the pay stub for Jan 13, 2026/);

    const y = (await client.get("/api/pay/2026")).json<PayYear>();
    expect(y.years).toEqual([2026]);
    expect(y.stubs).toHaveLength(1);
    const stub = y.stubs[0];
    expect(stub?.employer).toBe("Northwind Parts LLC");
    expect(stub?.deposits).toEqual([
      {
        cents: 78_800,
        last4: "4321",
        transaction: { id: "deposit-1", date: "2026-01-14", accountName: "Everyday Checking" },
      },
    ]);
    expect(y.breakdown).toMatchObject({
      source: "stubs",
      grossCents: 100_000,
      takeHomeCents: 78_800,
      deductions: [{ name: "Medical", cents: 5_000, preTax: true }],
    });
    expect(y.latest).toMatchObject({ periodsPerYear: 52, netCents: 78_800, taxesCents: 16_200 });

    const file = await client.get(`/api/pay/stubs/${stub?.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.body.startsWith("%PDF")).toBe(true);

    const docs = (await client.get("/api/documents")).json<DocumentInfo[]>();
    expect(docs).toContainEqual(
      expect.objectContaining({
        kind: "pay_stub",
        folder: "Pay / 2026",
        documentDate: "2026-01-13",
      }),
    );

    expect((await client.delete(`/api/pay/stubs/${stub?.id}`)).statusCode).toBe(200);
    expect((await client.get("/api/pay/2026")).json<PayYear>().stubs).toEqual([]);
  });

  it("flags a stub that doesn't add up, and refuses what it can't read", async () => {
    const { upload } = await setup();
    const off = await upload(stubPdf("01/20/2026", "-51.00*"));
    expect(off.json<PayUploadResult[]>()[0]?.problems).toEqual([
      "Gross pay less taxes and deductions is $787.00, not the net pay of $788.00.",
    ]);
    const other = await upload(makePdf([{ x: 50, y: 700, t: "Monthly statement" }]));
    expect(other.statusCode).toBe(400);
    expect(other.json().error).toMatch(/ADP earnings statements and W-2s/);
    const notPdf = await upload(Buffer.from("hello"));
    expect(notPdf.json().error).toMatch(/Upload the PDF/);
  });

  it("reads a W-2 and gives agents the totals", async () => {
    const { client, db, upload } = await setup();
    const res = await upload(w2Pdf(), "w2.pdf");
    expect(res.json<PayUploadResult[]>()).toEqual([
      expect.objectContaining({ kind: "w2", label: "2025 W-2" }),
    ]);
    const y = (await client.get("/api/pay/2025")).json<PayYear>();
    expect(y.w2s[0]?.boxes).toMatchObject({ wagesCents: 4_940_000, federalCents: 500_000 });
    expect(y.breakdown).toMatchObject({ source: "w2", healthCoverageCents: 1_500_000 });

    const tool = TOOL_MAP.get("get_pay_summary");
    const out = (await tool?.run(
      { db, today: "2026-11-15" } as never,
      { year: 2025 } as never,
    )) as {
      breakdown: { grossCents: number };
      w2s: unknown[];
    };
    expect(out.breakdown.grossCents).toBe(4_940_000);
    expect(out.w2s).toHaveLength(1);
  });

  it("tells the Import page which PDFs are pay stubs and W-2s, keeping nothing", async () => {
    const { client, db } = await setup();
    const kind = async (pdf: Buffer) =>
      (await client.post("/api/pay/detect", { base64: pdf.toString("base64") })).json().kind;
    expect(await kind(stubPdf("01/13/2026"))).toBe("stub");
    expect(await kind(w2Pdf())).toBe("w2");
    expect(await kind(makePdf([{ x: 50, y: 700, t: "Card statement" }]))).toBeNull();
    expect(await kind(Buffer.from("not a pdf"))).toBeNull();
    expect(db.select().from(schema.payStubs).all()).toEqual([]);
  });

  it("needs MUNY_SECRET_KEY to keep files", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/pay/documents", {
      filename: "stub.pdf",
      base64: stubPdf("01/13/2026").toString("base64"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/MUNY_SECRET_KEY/);
  });
});
