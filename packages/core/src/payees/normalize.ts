/**
 * Turn a raw bank description into a readable merchant name, e.g.
 *   "POS DEBIT SQ *BLUE BOTTLE COFFEE 0123 OAKLAND CA" -> "Blue Bottle Coffee"
 *   "ACME CORP PAYROLL PPD ID: 1234567890"           -> "Acme Corp Payroll"
 *   "AMZN Mktp US*2K4L71X02"                          -> "Amazon"
 *
 * Heuristic and deliberately conservative: it strips bank noise (card
 * prefixes, ACH tails, store numbers, dates, city/state) and title-cases what
 * is left. Returns null when nothing meaningful remains.
 */

/** Well-known merchants whose descriptions vary a lot. Matched against compacted text. */
const KNOWN: [RegExp, string][] = [
  [/^(amzn|amazon)(mktp|mktplace|\.com|com|prime|digital|retail|marketplace)?/, "Amazon"],
  [/^primevideo/, "Prime Video"],
  [/^google\*?fi(?!ber)/, "Google Fi"],
  [/^bp\d/, "BP"],
  [/^audible/, "Audible"],
  [/^apple\.?com\/?bill|^applecom|^itunes/, "Apple"],
  [/^netflix/, "Netflix"],
  [/^spotify/, "Spotify"],
  [/^hulu/, "Hulu"],
  [/^disney(plus|\+)/, "Disney+"],
  [/^(google)?youtube|^ytpremium/, "YouTube"],
  [/^uber\*?eats|^ubereats/, "Uber Eats"],
  [/^uber/, "Uber"],
  [/^lyft/, "Lyft"],
  [/^doordash|^dd\*?doordash/, "DoorDash"],
  [/^grubhub/, "Grubhub"],
  [/^instacart/, "Instacart"],
  [/^(wal-?mart|wm\s?supercenter|walmart)/, "Walmart"],
  [/^target/, "Target"],
  [/^costco/, "Costco"],
  [/^kroger/, "Kroger"],
  [/^starbucks/, "Starbucks"],
  [/^mcdonald/, "McDonald's"],
  [/^chick-?fil-?a/, "Chick-fil-A"],
  [/^dunkin/, "Dunkin'"],
  [/^venmo/, "Venmo"],
  [/^zelle/, "Zelle"],
  [/^openai|^chatgpt/, "OpenAI"],
  [/^anthropic|^claude\.ai/, "Anthropic"],
  [/^github/, "GitHub"],
  [/^microsoft|^msft/, "Microsoft"],
  [/^adobe/, "Adobe"],
  [/^dropbox/, "Dropbox"],
  [/^patreon/, "Patreon"],
  [/^steam(games|powered)?/, "Steam"],
  [/^playstation|^sony\s?playstation/, "PlayStation"],
  [/^xbox/, "Xbox"],
  [/^nintendo/, "Nintendo"],
  [/^home\s?depot/, "The Home Depot"],
  [/^lowes/, "Lowe's"],
  [/^cvs/, "CVS"],
  [/^walgreens/, "Walgreens"],
  [/^shell(oil)?/, "Shell"],
  [/^speedway/, "Speedway"],
  [/^exxon|^exxonmobil/, "Exxon"],
  [/^verizon/, "Verizon"],
  [/^at&?t/, "AT&T"],
  [/^t-?mobile/, "T-Mobile"],
  [/^comcast|^xfinity/, "Xfinity"],
  [/^spectrum/, "Spectrum"],
];

/** Card/ACH prefixes, removed repeatedly from the start. */
const PREFIXES = [
  /^purchase from\s+/i,
  /^(pos|pur|debit|dbt|chk|check ?card|checkcard|card purchase|visa|mastercard|purchase|recurring|electronic|online|preauthorized|pre-authorized|ach|atm|bill ?pay(ment)?|int'?l|international)\b[\s:-]*/i,
  /^(purchase|payment|pmt|debit|withdrawal|transfer|xfer|dep(osit)?) (authorized|auth|on|to|from)\b[\s:-]*/i,
  /^authorized on \d{1,2}\/\d{1,2}\b\s*/i,
  /^(purchase|pmt|debit) \d{1,2}\/\d{1,2}\b\s*/i,
  /^\d{1,2}\/\d{1,2}(\/\d{2,4})?\s+/,
  /^(sq|tst|sp|py|pp|ppl|in|ck|pos|fsp|bt|dd|sqc|ic|lc|pmnt)\s?\*\s*/i,
  /^paypal\s*\*\s*/i,
  /^paypal (inst xfer|purchase|transfer)[\s:;,~-]+/i,
  /^payment \d* ?to\s+/i,
  /^google\s*\*\s*/i,
];

/** Tails: ACH ids, reference numbers and the like. */
const TAILS = [
  /\s*[|;~].*$/,
  /\s+(direct dep(osit)?|dir dep)\b.*$/i,
  /\s+(mobile |web |online |e-)?(pmt|pymt|payment)\b.*$/i,
  /\s+ext\.? ?trnsfr\b.*$/i,
  /\s+(bill ?pay(ment)?|e-?bill|auto ?pay)\b.*$/i,
  /\s+(ppd|web|ccd|tel|ctx|arc|boc|pop|rck|cie)\s+id:?.*$/i,
  /\s+(co )?id:.*$/i,
  /\s+des:.*$/i,
  /\s+indn:.*$/i,
  /\s+(conf|confirmation|ref|reference|trace|auth|txn|trans)(#|\s*#|\s*no\.?|\s*number)?:?\s*\S*\d\S*.*$/i,
  /\s+card\s*(#|no\.?)?\s*x*\d{4}.*$/i,
  /\s+x{2,}\d{2,}.*$/i,
  /\s+on \d{1,2}\/\d{1,2}(\/\d{2,4})?.*$/i,
  /\s+pos (pur|rec)\b.*$/i,
];

/** Words that start a two-word city ("Ft. Worth", "New Albany", "St. Louis"). */
const CITY_PREFIX =
  /^(ft|fort|st|saint|mt|mount|new|north|south|east|west|lake|port|san|santa|los|las|el|la|palm)\.?$/i;

/** A name with a short number in it ("WD7", "PIX365"), unlike store or reference numbers. */
const WORDLIKE = /^[a-z]{2,4}\d{1,3}$/i;

/** Stands in for a phone number: dropped like any number, but it means "no city here". */
const PHONE = "#0";

const STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(
    " ",
  ),
);

/** Words kept upper-case after title-casing. */
const ACRONYMS = new Set(
  "ATM ACH USA US LLC IRS DMV CVS BP KFC IHOP UPS USPS HBO NYT AMC TJ TJX ATT AT&T IKEA AAA QT RV PC TV".split(
    " ",
  ),
);
const SMALL = new Set(["and", "of", "the", "for", "to", "at", "in", "on", "a", "an", "&"]);

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up) || /\d/.test(w)) return up;
      if (i > 0 && SMALL.has(w)) return w;
      // Keep things like "o'reilly" and "7-eleven" readable.
      return w.replace(/(^|[-'./])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
    })
    .join(" ");
}

/** Descriptions that are really a kind of movement rather than a merchant. */
const GENERIC: [RegExp, string][] = [
  [
    /^(online |mobile |internal |funds |ext(ernal)? )?(transfer|trnsfr|xfer)\b|\b(transfer|xfer) (to|from)\b/i,
    "Transfer",
  ],
  [/^payment to paypal credit/i, "PayPal Credit"],
  [
    /^(payment to )?paypal( inst xfer| transfer| purchase)?([\s:;,~-]+(ppd|web) id:.*)?\s*$/i,
    "PayPal",
  ],
  [/^(interest (paid|earned|payment|credit)|int(erest)? pd|interest$)/i, "Interest"],
  [/^(online )?payment thank you|^(automatic|auto) ?pay(ment)?\b/i, "Card Payment"],
  [/^atm (withdrawal|cash)|^withdrawal atm/i, "ATM Withdrawal"],
];

/**
 * Raw ACH (NACHA) descriptions, as some banks send them through Plaid:
 *   "ORIG CO NAME:CITIZENS CO ENTRY DESCR:MTG SEC:WEB TRACE#:... IND ID:..."
 * The company name is the merchant.
 */
const ACH_ORIG =
  /\borig(?:inator)? co(?:mpany)? name\s*:\s*(.+?)\s+(?:co entry descr|co id|sec|trace|ind id|ind name)\s*[:#]/i;

export function cleanPayeeName(raw: string): string | null {
  let s = raw.replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const ach = ACH_ORIG.exec(s)?.[1]?.trim();
  if (ach && /[a-z]{2}/i.test(ach)) s = ach;
  for (const [re, name] of GENERIC) if (re.test(s)) return name;

  const compact = s
    .toLowerCase()
    .replace(/^(pos|debit|purchase|card|sq \*|tst\* ?|paypal \*)\s*/g, "");
  for (const [re, name] of KNOWN) {
    if (re.test(compact.replace(/\s+/g, "")) || re.test(compact)) return name;
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREFIXES) {
      const next = s.replace(re, "");
      if (next !== s && next.trim()) {
        s = next.trim();
        changed = true;
      }
    }
  }
  for (const re of TAILS) s = s.replace(re, "");

  // Re-check known merchants once prefixes are gone (e.g. "SQ *STARBUCKS").
  const compact2 = s.toLowerCase().replace(/\s+/g, "");
  for (const [re, name] of KNOWN) if (re.test(compact2)) return name;

  // Phone numbers become a marker; drop URLs' TLD; "PILOT_1234" -> "PILOT".
  s = s
    .replace(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{3}-\d{4})\b/g, ` ${PHONE} `)
    .replace(/\.(com|net|org|io|co)\b/gi, "")
    .replace(/\bwww\./gi, "")
    .replace(/_\d+\b/g, " ")
    // "MILL HALL, PA, USA" -> "MILL HALL PA"
    .replace(/,\s*([a-z]{2})(,\s*(usa|us))?\s*$/i, " $1");
  // Keep words, and names with a short number ("WD7"); drop store and reference numbers.
  const keep = (w: string) => !/^[#*\-/.:,]+$/.test(w) && (!/\d/.test(w) || WORDLIKE.test(w));
  const kept = (ws: string[]) => ws.filter(keep).length;
  let words = s.split(/\s+/).filter(Boolean);
  // Trailing posting dates and reference numbers ("... TX 123456 01/06").
  while (/^(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d+|#0)$/.test(words[words.length - 1] ?? "")) {
    // Keep a phone marker right after a name: it's what says "no city" before a state.
    if (words[words.length - 1] === PHONE && !STATES.has(words[words.length - 2] ?? "")) break;
    words.pop();
  }

  // Trailing "CITY ST": drop the state, then the city (one word, or two like
  // "Ft. Worth"), unless a phone or store number stands where the city would be.
  const last = words[words.length - 1];
  if (last && STATES.has(last.toUpperCase()) && last === last.toUpperCase()) {
    const before = words.slice(0, -1);
    const city = before[before.length - 1];
    // "POWER CO" is a name; "WD7 512-555-0142 TX" and "CAFE AUSTIN TX" end in a place.
    if (kept(before) >= 2 || (kept(before) >= 1 && city !== undefined && !keep(city))) {
      words = before;
      if (city && keep(city) && !/\d/.test(city) && kept(before) >= 2) {
        words = before.slice(0, -1);
        const pre = words[words.length - 1];
        if (pre && CITY_PREFIX.test(pre) && kept(words) >= 2) words.pop();
      }
    }
  }
  const tokens = words.filter(keep);

  const out = titleCase(
    tokens
      .join(" ")
      .replace(/^[\s*#\-.:,/]+|[\s*#\-.:,/]+$/g, "")
      .replace(/\s*\*\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (out.replace(/[^a-z]/gi, "").length < 2) return null;
  return out.slice(0, 100);
}

/**
 * A description's shape: its words without numbers, dates, ids or punctuation.
 * Charges from one merchant usually share it ("WD7 512-555-0142 TX 01/06" and
 * "WD7 512-555-0142 TX 02/05" -> "wd tx"), so a new charge can reuse the
 * merchant earlier ones have, whatever the name cleanup would say today.
 * Null when too little is left to tell merchants apart.
 */
export function descriptionShape(raw: string): string | null {
  const shape = raw
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z&'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shape.replace(/[^a-z]/g, "").length >= 4 ? shape : null;
}
