/**
 * Colors for things shown side by side in charts (categories, coins,
 * holdings). The largest few get a categorical slot; everything else shares
 * "Other". Slots are handed out in a stable order (`order`, e.g. creation or
 * name), never by size rank, so a price move doesn't repaint anything.
 */
export const SERIES_SLOTS = 8;
export const OTHER_COLOR = "var(--viz-other)";
export const seriesColor = (i: number) =>
  i < SERIES_SLOTS ? `var(--viz-series-${i + 1})` : OTHER_COLOR;

export function assignColors<K extends string>(
  items: { key: K; value: number; order: string }[],
  slots = SERIES_SLOTS - 1,
): Map<K, string> {
  const top = [...items]
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, items.filter((x) => x.value > 0).length > slots + 1 ? slots : slots + 1);
  const ordered = [...top].sort((a, b) => a.order.localeCompare(b.order));
  const out = new Map<K, string>();
  ordered.forEach((x, i) => {
    out.set(x.key, seriesColor(i));
  });
  for (const x of items) if (!out.has(x.key)) out.set(x.key, OTHER_COLOR);
  return out;
}
