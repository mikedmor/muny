/**
 * The icon list for category icons: ~1,900 emoji (emojibase, MIT) with names,
 * keywords and shortcodes, shipped with Muny and loaded on demand.
 */

export interface Entry {
  emoji: string;
  label: string;
  /** Lower-case words to match: label, tags, shortcodes, extra synonyms. */
  words: string[];
}

/** Money words the emoji keywords don't cover. */
export const SYNONYMS: Record<string, string[]> = {
  "🤖": ["ai", "artificial intelligence", "chatbot", "llm"],
  "💡": ["utilities", "utility", "electric", "power"],
  "🚰": ["water", "sewer", "utilities"],
  "💧": ["water", "sewer"],
  "📶": ["internet", "wifi", "cell", "mobile"],
  "🏠": ["rent", "mortgage", "housing"],
  "🛡️": ["insurance"],
  "🏦": ["loan", "bank", "debt"],
  "💳": ["credit card", "card payment"],
  "📈": ["investing", "stocks", "brokerage"],
  "🧾": ["tax", "taxes", "receipt", "fees"],
  "🔁": ["subscription", "subscriptions", "recurring"],
  "🛒": ["groceries", "grocery"],
  "⛽": ["gas", "fuel"],
  "🚗": ["auto", "car payment", "transport"],
  "🎓": ["education", "tuition", "student loan"],
  "💊": ["pharmacy", "medical", "health"],
  "🐾": ["pet", "pets", "vet"],
  "🎁": ["gifts", "donations", "charity"],
  "💻": ["software", "apps", "computer", "saas"],
  "☁️": ["cloud", "hosting", "server"],
  "🏋️": ["gym", "fitness"],
  "💇": ["personal care", "hair", "beauty"],
  "🧸": ["kids", "childcare", "toys"],
};

let cache: Promise<Entry[]> | null = null;
export function loadEmoji(): Promise<Entry[]> {
  cache ??= Promise.all([
    import("emojibase-data/en/compact.json"),
    import("emojibase-data/en/shortcodes/github.json"),
  ]).then(([data, codes]) => {
    const list = (data.default ?? data) as unknown as {
      hexcode: string;
      label: string;
      unicode: string;
      tags?: string[];
      group?: number;
    }[];
    const sc = (codes.default ?? codes) as unknown as Record<string, string | string[]>;
    return (
      list
        // Group 2 is skin tones and hair parts, not icons.
        .filter((e) => e.group !== 2 && e.group !== undefined)
        .map((e) => {
          const short = sc[e.hexcode];
          return {
            emoji: e.unicode,
            label: e.label,
            words: [
              e.label.toLowerCase(),
              ...(e.tags ?? []),
              ...(Array.isArray(short) ? short : short ? [short] : []).map((s) =>
                s.replace(/_/g, " "),
              ),
              ...(SYNONYMS[e.unicode] ?? []),
            ],
          };
        })
    );
  });
  return cache;
}

/** Best matches first: whole word, then starts with, then contains. */
export function searchIcons(all: Entry[], query: string): Entry[] {
  const q = query.toLowerCase().replace(/^:|:$/g, "").trim();
  if (!q) return [];
  const score = (e: Entry) => {
    let best = 0;
    for (const w of e.words) {
      if (w === q) best = Math.max(best, w === e.label.toLowerCase() ? 5 : 4);
      else if (w.split(/\s+/).includes(q)) best = Math.max(best, 3);
      else if (w.startsWith(q)) best = Math.max(best, 2);
      else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 1);
    }
    return best;
  };
  return all
    .map((e) => [e, score(e)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([e]) => e);
}
