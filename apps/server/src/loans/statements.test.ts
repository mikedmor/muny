import type { LoanStatementPreview, LoansReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { parseLoanStatement, pdfLines } from "./statements.js";

// A synthetic statement laid out like a servicer's: a summary, then a table with
// a column per loan group. Made-up numbers only.

/** A one-page PDF with text at positions (enough for a text layer). */
function makePdf(cells: { x: number; y: number; t: string }[]): Uint8Array {
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
  return new TextEncoder().encode(out);
}

function statementPdf(date = "10/6/2026", paidXA = "$150.00", principalXA = "$600.00") {
  const cells: { x: number; y: number; t: string }[] = [];
  let y = 760;
  const line = (label: string, ...values: string[]) => {
    cells.push({ x: 40, y, t: label });
    values.forEach((v, i) => {
      cells.push({ x: 260 + i * 90, y, t: v });
    });
    y -= 14;
  };
  line("Statement Date", "", date);
  line("Current Balance", "", "$1,010.00");
  line("Last Payment (Effective 9/28/2026)", "", "$150.00");
  y -= 20;
  line("Account Snapshot:", "Group XA", "Group XB");
  line("Loan Type", "DIRECT UNSUB", "DIRECT UNSUB");
  line("Original Principal Amount", "$2,000.00", "$1,500.00");
  line("First Disbursement Date", "10/4/2010", "8/13/2012");
  line("Interest Rate", "6.000%", "5.000%");
  line("Daily Interest*", "$0.10", "$0.05");
  line("Accrued Interest on 10/6/2026", "$1.00", "$9.00");
  line("Estimated Interest* on 10/28/2026", "$3.00", "$12.00");
  line("Regular Monthly Payment Amount", "$100.00", "$50.00");
  line("Outstanding Principal Balance* on", principalXA, "$400.00");
  line("Loan Term (payments remaining)", "12", "17");
  line("Payment Summary:");
  line("Total Amount Paid Since Last Statement", paidXA, "$0.00");
  line("Applied to Interest", "$4.00", "$0.00");
  line("Applied to Principal", "$146.00", "$0.00");
  line("Billing Details:");
  line("Past Due Amount", "$0.00", "$0.00");
  line("Amount Due", "$25.00", "$50.00");
  line("Due Date", "9/28/2027", "6/28/2027");
  return makePdf(cells.filter((c) => c.t));
}

describe("loan statements", () => {
  it("reads each group's figures from the PDF", async () => {
    const s = parseLoanStatement(await pdfLines(statementPdf()));
    expect(s?.statementDate).toBe("2026-10-06");
    expect(s?.lastPayment).toEqual({ date: "2026-09-28", amountCents: 15_000 });
    expect(s?.groups.map((g) => g.name)).toEqual(["XA", "XB"]);
    expect(s?.groups[0]).toMatchObject({
      aprBps: 600,
      principalCents: 60_000,
      accruedInterestCents: 100,
      monthlyPaymentCents: 10_000,
      paidCents: 15_000,
      paidInterestCents: 400,
      paidPrincipalCents: 14_600,
      dueDate: "2027-09-28",
      firstDisbursed: "2010-10-04",
      originalPrincipalCents: 200_000,
    });
    expect(s?.groups[1]).toMatchObject({ aprBps: 500, paidCents: 0, dueDate: "2027-06-28" });
  });

  it("brings the lender's loans in line with a statement", async () => {
    const { client } = await makeSignedInApp();
    await client.post("/api/loans/batch", {
      lender: "Servicer",
      kind: "student",
      loans: [{ name: "Group XA", startBalanceCents: 90_000, aprBps: 600 }],
      payments: [],
    });
    const pdfBase64 = Buffer.from(statementPdf()).toString("base64");
    const pre = await client.post("/api/loans/statements/preview", {
      lender: "Servicer",
      pdfBase64,
    });
    expect(pre.statusCode).toBe(200);
    const preview = pre.json<LoanStatementPreview>();
    expect(preview.matches.XB).toBe("new");
    expect(preview.matches.XA).not.toBe("new");

    const applied = await client.post("/api/loans/statements/apply", {
      lender: "Servicer",
      statement: preview.statement,
      mapping: preview.matches,
    });
    expect(applied.statusCode).toBe(200);
    const loans = (await client.get("/api/loans")).json<LoansReport>().loans;
    const xa = loans.find((l) => l.name === "Group XA");
    const xb = loans.find((l) => l.name === "Group XB");
    expect(xa).toMatchObject({
      aprBps: 600,
      monthlyPaymentCents: 10_000,
      nextDueDate: "2027-09-28",
    });
    expect(xa?.startDate).toBe("2026-10-06");
    expect(xa?.payments[0]).toMatchObject({
      date: "2026-09-28",
      amountCents: 15_000,
      interestCents: 400,
      principalCents: 14_600,
    });
    expect(xb?.startBalanceCents).toBe(40_900);
    expect(xb?.payments).toHaveLength(0);

    // An older statement adds history but doesn't move the balance back.
    const older = (
      await client.post("/api/loans/statements/preview", {
        lender: "Servicer",
        pdfBase64: Buffer.from(statementPdf("9/6/2026", "$150.00", "$746.00")).toString("base64"),
      })
    ).json<LoanStatementPreview>();
    expect(older.matches.XB).not.toBe("new");
    await client.post("/api/loans/statements/apply", {
      lender: "Servicer",
      statement: older.statement,
      mapping: older.matches,
      pdfBase64: Buffer.from(statementPdf("9/6/2026", "$150.00", "$746.00")).toString("base64"),
      fileName: "september.pdf",
    });
    const after = (await client.get("/api/loans")).json<LoansReport>().loans;
    const xa2 = after.find((l) => l.name === "Group XA");
    expect(xa2?.startDate).toBe("2026-10-06");
    expect(xa2?.startBalanceCents).toBe(60_100);
    expect(xa2?.payments.filter((p) => p.description === "From your statement")).toHaveLength(2);
    // Kept under Documents, once.
    const docs = (await client.get("/api/documents")).json<{ name: string; kind: string }[]>();
    expect(docs).toEqual([
      expect.objectContaining({ name: "september.pdf", kind: "loan_statement" }),
    ]);

    // Not a PDF.
    const bad = await client.post("/api/loans/statements/preview", {
      lender: "Servicer",
      pdfBase64: Buffer.from("hello there, not a pdf").toString("base64"),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("splits later payments like the servicer: what's due, then the highest rate", async () => {
    const { client } = await makeSignedInApp();
    const chk = (await client.post("/api/accounts", { name: "Checking", type: "checking" })).json<{
      id: string;
    }>();
    const group = (
      name: string,
      aprBps: number,
      monthlyPaymentCents: number,
      principalCents: number,
      dueDate: string,
    ) => ({
      name,
      aprBps,
      originalPrincipalCents: null,
      firstDisbursed: null,
      principalCents,
      accruedInterestCents: 0,
      monthlyPaymentCents,
      paymentsLeft: null,
      paidCents: 0,
      paidInterestCents: 0,
      paidPrincipalCents: 0,
      amountDueCents: null,
      dueDate,
    });
    const statement = {
      statementDate: "2026-10-06",
      lastPayment: null,
      groups: [
        group("XA", 425, 4_000, 200_000, "2026-11-15"),
        group("XC", 655, 3_000, 40_000, "2027-09-28"),
        group("XD", 655, 9_000, 120_000, "2027-09-28"),
        group("XE", 580, 5_000, 80_000, "2027-06-28"),
      ],
    };
    const mapping = { XA: "new", XC: "new", XD: "new", XE: "new" };
    await client.post("/api/loans/statements/apply", {
      lender: "Servicer",
      statement,
      mapping,
    });
    // Words for finding the payments.
    const report0 = (await client.get("/api/loans")).json<LoansReport>();
    for (const l of report0.loans)
      await client.patch(`/api/loans/${l.accountId}`, { paymentMatch: "DEPT EDUCATION" });
    await client.post("/api/transactions", {
      accountId: chk.id,
      postedDate: "2026-10-28",
      amountCents: -20_000,
      description: "DEPT EDUCATION STUDENT LN",
    });
    const report = (await client.get("/api/loans")).json<LoansReport>();
    expect(report.servicerLenders).toEqual(["servicer"]);
    const paid = (n: string) =>
      report.loans.find((l) => l.name === `Group ${n}`)?.payments.map((p) => p.amountCents) ?? [];
    expect(paid("XA")).toEqual([4_000]); // what was due
    // The rest ($160) to the 6.55% groups by balance (40k : 120k); none to XE.
    expect(paid("XC")).toEqual([4_000]);
    expect(paid("XD")).toEqual([12_000]);
    expect(paid("XE")).toEqual([]);
    const xa = report.loans.find((l) => l.name === "Group XA");
    expect(xa?.statementDate).toBe("2026-10-06");
    expect(xa?.history.at(-1)?.balanceCents).toBe(xa?.balanceCents);
  });
});
