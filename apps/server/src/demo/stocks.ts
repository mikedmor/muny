import { addDaysIso, addInterval } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import { eq } from "drizzle-orm";

/**
 * The demo household's investments: a taxable brokerage account and a Roth
 * IRA, with a few years of made-up trades, so the Stocks pages, the tax views
 * and Reconcile all have something to show. Tickers and companies are
 * invented; with live details on, Muny simply finds nothing for them.
 *
 * - XIDX: bought over three years, mostly long term now.
 * - SRBT: some sold at a long-term gain; 5 more bought 10 days ago.
 * - QWTR: bought six months ago, now at a loss, and bought again in the Roth
 *   IRA 12 days ago: selling it at a loss now would be a wash sale.
 * - FZBK: held, with no trade history (Reconcile asks for it).
 */
export function seedDemoStocks(db: MunyDb, today: string) {
  const months = (n: number) => addInterval(today, "monthly", -n);
  const acct = (name: string, mask: string, subtype: string) => {
    const id = newId();
    db.insert(schema.accounts)
      .values({
        id,
        name,
        type: "investment",
        institutionName: "Example Invest Co",
        mask,
        subtype,
        balanceSource: "reported",
      })
      .run();
    return id;
  };
  const brokerage = acct("Sample Brokerage", "0404", "brokerage");
  const roth = acct("Sample Roth IRA", "0505", "roth");

  const sec = (symbol: string, name: string, type: "equity" | "etf") => {
    const id = newId();
    db.insert(schema.securities).values({ id, symbol, name, type }).run();
    return id;
  };
  const xidx = sec("XIDX", "Example Total Market Index ETF", "etf");
  const srbt = sec("SRBT", "Sample Robotics Inc.", "equity");
  const qwtr = sec("QWTR", "Quietwater Utilities Co.", "equity");
  const fzbk = sec("FZBK", "Fizzbank Corp.", "equity");

  let n = 0;
  const trade = (
    accountId: string,
    securityId: string,
    date: string,
    type: "buy" | "sell" | "dividend",
    quantity: string | null,
    price: string | null,
    amountCents: number,
  ) =>
    db
      .insert(schema.investmentTxns)
      .values({
        id: newId(),
        accountId,
        securityId,
        date,
        type,
        quantity,
        price,
        amountCents,
        externalId: `demo:${++n}`,
        source: "import",
      })
      .run();

  trade(brokerage, xidx, months(36), "buy", "40", "80", -320_000);
  trade(brokerage, xidx, months(8), "buy", "10", "95", -95_000);
  trade(brokerage, srbt, months(24), "buy", "30", "120", -360_000);
  trade(brokerage, srbt, months(5), "sell", "10", "150", 150_000);
  trade(brokerage, srbt, addDaysIso(today, -10), "buy", "5", "170", -85_000);
  trade(brokerage, qwtr, months(6), "buy", "50", "40", -200_000);
  trade(roth, xidx, months(34), "buy", "30", "90", -270_000);
  trade(roth, qwtr, addDaysIso(today, -12), "buy", "10", "35", -35_000);
  for (const m of [10, 7, 4, 1]) trade(brokerage, xidx, months(m), "dividend", null, null, 4_200);
  trade(roth, xidx, months(1), "dividend", null, null, 2_500);

  const holdings: [string, string, string, string, number, number][] = [
    [brokerage, xidx, "50", "104", 520_000, 415_000],
    [brokerage, srbt, "25", "172", 430_000, 325_000],
    [brokerage, qwtr, "50", "34", 170_000, 200_000],
    [brokerage, fzbk, "25", "61", 152_500, 100_000],
    [roth, xidx, "30", "104", 312_000, 270_000],
    [roth, qwtr, "10", "34", 34_000, 35_000],
  ];
  for (const [accountId, securityId, quantity, price, valueCents, costBasisCents] of holdings)
    db.insert(schema.investmentHoldings)
      .values({
        accountId,
        securityId,
        quantity,
        price,
        valueCents,
        costBasisCents,
        asOf: today,
        source: "import",
      })
      .run();

  // Six months of value history, rising to today's.
  for (const [id, now] of [
    [brokerage, 520_000 + 430_000 + 170_000 + 152_500],
    [roth, 312_000 + 34_000],
  ] as const) {
    db.update(schema.accounts)
      .set({ currentBalanceCents: now })
      .where(eq(schema.accounts.id, id))
      .run();
    for (let m = 6; m >= 0; m--)
      db.insert(schema.balanceSnapshots)
        .values({
          accountId: id,
          date: m ? months(m) : today,
          balanceCents: Math.round(now * (1 - m * 0.012 + (m % 2 ? 0.006 : 0))),
        })
        .onConflictDoNothing()
        .run();
  }
}
