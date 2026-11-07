/** Search text for "transactions like this one" (the magnifying glass). */

/** Words that are references, not names: anything with a digit, or only symbols. */
const isReference = (w: string) => /\d/.test(w) || /^[^A-Za-z]+$/.test(w);

/**
 * What to search for. A payee name is used as is. A bank description gives
 * its longest run of words without numbers (the first, on a tie), at most
 * five words, cut from the original text so it still matches as written:
 * "ACH DEBIT CITY ELECTRIC 0042 WEB" → "ACH DEBIT CITY ELECTRIC",
 * "POS 1234 COFFEE SHOP #55" → "COFFEE SHOP".
 */
export function similarQuery(text: string, isPayee = false): string {
  if (isPayee) return text.trim().replace(/\s+/g, " ").slice(0, 100);
  const words = [...text.matchAll(/\S+/g)].map((m) => ({
    w: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  let best: typeof words = [];
  let run: typeof words = [];
  for (const w of [...words, null]) {
    if (w && !isReference(w.w)) {
      run.push(w);
      continue;
    }
    if (run.length > best.length) best = run;
    run = [];
  }
  best = best.slice(0, 5);
  const first = best[0];
  const last = best.at(-1);
  if (!first || !last) return text.trim().slice(0, 100);
  return text.slice(first.start, last.end).slice(0, 100);
}
