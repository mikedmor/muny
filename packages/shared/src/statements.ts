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
