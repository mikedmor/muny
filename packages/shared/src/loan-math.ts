/**
 * Loan math in integer cents (D-040).
 *
 * applyPayments: from a known balance on a date, each payment first covers
 * the interest that built up since the last one (daily, at the APR over 365
 * days) and the rest comes off the balance.
 *
 * payoff: how long a balance takes to pay off at a monthly payment (plus any
 * extra), with interest charged monthly at APR/12.
 */

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Round a bigint ratio half up (both non-negative). */
const div = (n: bigint, d: bigint) => (n + d / 2n) / d;

export interface LoanPayment {
  date: string;
  /** What you paid (positive cents). */
  amountCents: number;
}

export interface AppliedPayment extends LoanPayment {
  interestCents: number;
  principalCents: number;
  balanceAfterCents: number;
}

export function applyPayments(
  startBalanceCents: number,
  aprBps: number,
  startDate: string,
  payments: LoanPayment[],
  asOf?: string,
): {
  balanceCents: number;
  interestPaidCents: number;
  principalPaidCents: number;
  /** Interest built up since the last payment, not yet paid. */
  accruedCents: number;
  payments: AppliedPayment[];
} {
  let bal = BigInt(Math.max(0, startBalanceCents));
  let last = startDate;
  let interestPaid = 0;
  let principalPaid = 0;
  const out: AppliedPayment[] = [];
  const accrue = (to: string) => {
    const days = Math.max(0, Math.round(dayNum(to) - dayNum(last)));
    return div(bal * BigInt(aprBps) * BigInt(days), 10000n * 365n);
  };
  for (const p of [...payments].sort((a, b) => a.date.localeCompare(b.date))) {
    if (p.date < startDate || p.amountCents <= 0) continue;
    const interest = accrue(p.date);
    const pay = BigInt(p.amountCents);
    const towardInterest = pay < interest ? pay : interest;
    let principal = pay - towardInterest;
    if (principal > bal) principal = bal;
    // Unpaid interest is added to what's owed.
    bal = bal + (interest - towardInterest) - principal;
    last = p.date;
    interestPaid += Number(towardInterest);
    principalPaid += Number(principal);
    out.push({
      ...p,
      interestCents: Number(towardInterest),
      principalCents: Number(principal),
      balanceAfterCents: Number(bal),
    });
  }
  return {
    balanceCents: Number(bal),
    interestPaidCents: interestPaid,
    principalPaidCents: principalPaid,
    accruedCents: asOf ? Number(accrue(asOf)) : 0,
    payments: out,
  };
}

export interface PayoffPlan {
  /** Months until paid off; null when the payment doesn't cover the interest. */
  months: number | null;
  totalInterestCents: number;
  /** Balance at the end of each month (index 0 = today). */
  balances: number[];
}

export function payoff(
  balanceCents: number,
  aprBps: number,
  monthlyCents: number,
  extraCents = 0,
  maxMonths = 600,
): PayoffPlan {
  let bal = BigInt(Math.max(0, balanceCents));
  const pay = BigInt(Math.max(0, monthlyCents + extraCents));
  const balances = [Number(bal)];
  let interest = 0n;
  for (let m = 1; m <= maxMonths && bal > 0n; m++) {
    const i = div(bal * BigInt(aprBps), 10000n * 12n);
    if (pay <= i) return { months: null, totalInterestCents: Number(interest), balances };
    interest += i;
    bal = bal + i - pay;
    if (bal < 0n) bal = 0n;
    balances.push(Number(bal));
  }
  return {
    months: bal > 0n ? null : balances.length - 1,
    totalInterestCents: Number(interest),
    balances,
  };
}
