import type { CardStatement } from "./cards.js";
import type { SingleLoanStatement } from "./loans.js";

/**
 * Statement templates: how to read a statement Muny's built-in readers miss,
 * taught once (Teach Muny, or through the API) and applied to every statement
 * whose text contains its match text.
 */

export type StatementKind = "card" | "loan";
export type TemplateFieldType = "money" | "date" | "percent";

/** The fields a template can teach, by kind, with what kind of value each is. */
export const TEMPLATE_FIELDS: Record<
  StatementKind,
  { key: string; label: string; type: TemplateFieldType }[]
> = {
  card: [
    { key: "newBalanceCents", label: "New balance", type: "money" },
    { key: "minimumPaymentCents", label: "Minimum payment due", type: "money" },
    { key: "dueDate", label: "Payment due date", type: "date" },
    { key: "closingDate", label: "Statement closing date", type: "date" },
    { key: "creditLimitCents", label: "Credit limit", type: "money" },
    { key: "aprBps", label: "Purchase APR", type: "percent" },
  ],
  loan: [
    { key: "balanceCents", label: "What you owe (principal or balance)", type: "money" },
    { key: "paymentCents", label: "Regular payment or amount due", type: "money" },
    { key: "dueDate", label: "Payment due date", type: "date" },
    { key: "statementDate", label: "Statement date", type: "date" },
    { key: "aprBps", label: "Interest rate", type: "percent" },
  ],
};

export interface StatementTemplate {
  id: string;
  kind: StatementKind;
  name: string;
  /** Text that identifies these statements (e.g. the bank's web address). */
  matchText: string;
  /** Field key → the label text its value follows on the same line. */
  fields: Record<string, { label: string }>;
}

export interface StatementTemplateInput {
  kind: StatementKind;
  name: string;
  matchText: string;
  fields: Record<string, { label: string }>;
}

/** Which statements an account has: the newest one, and the monthly ones since that are missing. */
export interface StatementStatus {
  accountId: string;
  /** YYYY-MM-DD: the newest statement's date (read, or stored with a date you gave). */
  lastDate: string;
  /** Statements Muny has for the account. */
  count: number;
  /** YYYY-MM-DD: when the next monthly statement is due to close. */
  nextDate: string;
  /** Monthly statements that should exist (since the first one) but aren't in Muny. */
  missing: number;
  /** Those months, YYYY-MM, oldest first (the latest 24). */
  missingMonths: string[];
}

/** Any statement PDF, read to suggest what it is and which account it's for. */
export interface StatementPreview {
  /** card or loan (one loan); groups: several loans on one statement; unknown: couldn't tell. */
  kind: "card" | "loan" | "groups" | "unknown";
  /** The account whose last 4 digits appear on it. */
  accountId: string | null;
  /** The last 4 digits found on it (to name a new account). */
  mask: string | null;
  /** The statement's date, if read. */
  date: string | null;
  card: CardStatement;
  loan: SingleLoanStatement;
  groups: string[];
  lines: string[];
  templates: string[];
}
