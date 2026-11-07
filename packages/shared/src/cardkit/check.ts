/**
 * Checks a card without running it, so the editor can point at a mistake while
 * you type and the server can refuse a card that could never work.
 */
import { DATASET_BY_ID, type DatasetInfo, findField } from "./catalog.js";
import { BLOCK_KIND_INFO, type CardBlock, type CardDoc, type CardQuery } from "./doc.js";
import { ExprError, exprRefs, parseExpr } from "./expr.js";

export interface CardIssue {
  /** The block it's in, if it's in one. */
  block?: string;
  message: string;
}

export const INTERNAL_LINK = /^\/(?!\/)[A-Za-z0-9/_-]*$/;

function templateFormulas(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/\{\{(.+?)\}\}/g)].map((m) => m[1] ?? "").filter(Boolean);
}

function checkFormula(
  source: string,
  known: { fields?: (name: string) => boolean; metrics: Set<string> },
  report: (message: string) => void,
) {
  try {
    const { refs, metrics } = exprRefs(parseExpr(source));
    for (const m of metrics)
      if (!known.metrics.has(m.toLowerCase())) report(`This card has no value called $${m}.`);
    if (known.fields)
      for (const r of refs) if (!known.fields(r)) report(`Muny can't find "${r}" here.`);
  } catch (e) {
    report(e instanceof ExprError ? e.message : "That formula can't be read.");
  }
}

function checkQuery(
  query: CardQuery,
  metrics: Set<string>,
  report: (message: string) => void,
): DatasetInfo | null {
  const dataset = DATASET_BY_ID.get(query.dataset);
  if (!dataset) {
    report(`There's no dataset called "${query.dataset}".`);
    return null;
  }
  const calculated = new Set<string>();
  for (const c of query.calculated ?? []) {
    calculated.add(c.id.toLowerCase());
    if (c.label) calculated.add(c.label.toLowerCase());
  }
  const isField = (name: string) =>
    calculated.has(name.trim().toLowerCase()) || !!findField(dataset, name);
  const measureNames = new Set<string>();
  for (const m of query.measures ?? []) {
    measureNames.add(m.id.toLowerCase());
    if (m.label) measureNames.add(m.label.toLowerCase());
  }
  const dimNames = new Set<string>();
  for (const d of query.dimensions ?? []) {
    dimNames.add(d.field.toLowerCase());
    if (d.label) dimNames.add(d.label.toLowerCase());
  }
  const isGroupName = (name: string) => {
    const key = name.trim().toLowerCase();
    return measureNames.has(key) || dimNames.has(key) || isField(name);
  };

  for (const c of query.calculated ?? [])
    checkFormula(c.expr, { fields: isField, metrics }, (message) =>
      report(`${c.label ?? c.id}: ${message}`),
    );
  for (const f of query.filters ?? [])
    if (!isField(f.field)) report(`${dataset.label} has no field called "${f.field}".`);
  for (const d of query.dimensions ?? [])
    if (!isField(d.field)) report(`${dataset.label} has no field called "${d.field}".`);
  const seen = new Set<string>();
  for (const m of query.measures ?? []) {
    if (seen.has(m.id)) report(`Two values are both called "${m.id}".`);
    seen.add(m.id);
    if (m.field && !isField(m.field)) report(`${dataset.label} has no field called "${m.field}".`);
    if (m.expr)
      checkFormula(m.expr, { fields: isGroupName, metrics }, (message) =>
        report(`${m.label ?? m.id}: ${message}`),
      );
  }
  return dataset;
}

function checkBlock(block: CardBlock, metrics: Set<string>, report: (message: string) => void) {
  const info = BLOCK_KIND_INFO[block.kind];
  if (block.query) checkQuery(block.query, metrics, report);
  for (const layer of block.layers ?? []) checkQuery(layer, metrics, report);
  const o = block.options ?? {};

  // Block settings can use named values and the block's own measures.
  const names = new Set<string>();
  for (const m of block.query?.measures ?? []) {
    names.add(m.id.toLowerCase());
    if (m.label) names.add(m.label.toLowerCase());
  }
  const known = { fields: (n: string) => names.has(n.trim().toLowerCase()), metrics };
  for (const source of [o.value, o.compare, o.toneExpr, o.marker, o.target])
    if (source && !names.has(source.toLowerCase())) checkFormula(source, known, report);
  for (const r of o.references ?? []) checkFormula(r.expr, known, report);
  for (const source of [...templateFormulas(o.text), ...templateFormulas(o.center)])
    checkFormula(source, known, report);
  if (o.link && !INTERNAL_LINK.test(o.link.to))
    report(`Links go to a page inside Muny, like /budgets, not "${o.link.to}".`);
  if (!info.query && block.query) report(`${info.label} doesn't use data.`);
}

export function checkCardDoc(doc: CardDoc): CardIssue[] {
  const issues: CardIssue[] = [];
  const metrics = new Set((doc.metrics ?? []).map((m) => m.id.toLowerCase()));
  const seenMetrics = new Set<string>();
  for (const m of doc.metrics ?? []) {
    const report = (message: string) => issues.push({ message: `$${m.id}: ${message}` });
    if (seenMetrics.has(m.id)) report("Two values have this name.");
    seenMetrics.add(m.id);
    if (m.dataset) {
      const dataset = DATASET_BY_ID.get(m.dataset);
      if (!dataset) {
        report(`There's no dataset called "${m.dataset}".`);
        continue;
      }
      for (const f of m.filters ?? [])
        if (!findField(dataset, f.field))
          report(`${dataset.label} has no field called "${f.field}".`);
      checkFormula(m.expr, { fields: (n) => !!findField(dataset, n), metrics }, report);
    } else {
      checkFormula(m.expr, { metrics }, report);
    }
  }
  const seenBlocks = new Set<string>();
  for (const block of doc.blocks) {
    const report = (message: string) => issues.push({ block: block.id, message });
    if (seenBlocks.has(block.id)) report("Two blocks share an id.");
    seenBlocks.add(block.id);
    checkBlock(block, metrics, report);
  }
  return issues;
}
