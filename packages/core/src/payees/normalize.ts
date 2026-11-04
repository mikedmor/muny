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
  /^(pos|debit|dbt|chk|check ?card|checkcard|card purchase|visa|mastercard|purchase|recurring|electronic|online|preauthorized|pre-authorized|ach|atm|bill ?pay(ment)?|int'?l|international)\b[\s:-]*/i,
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
  /\s+(ppd|web|ccd|tel|ctx|arc|boc|pop|rck|cie)\s+id:?.*$/i,
  /\s+(co )?id:.*$/i,
  /\s+des:.*$/i,
  /\s+indn:.*$/i,
  /\s+(conf|confirmation|ref|reference|trace|auth|txn|trans)(#|\s*#|\s*no\.?|\s*number)?:?\s*\S*\d\S*.*$/i,
  /\s+card\s*(#|no\.?)?\s*x*\d{4}.*$/i,
  /\s+x{2,}\d{2,}.*$/i,
  /\s+on \d{1,2}\/\d{1,2}(\/\d{2,4})?.*$/i,
];

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
      if (ACRONYMS.has(up)) return up;
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

export function cleanPayeeName(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
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

  // Drop URLs' TLD, phone numbers, store numbers and other digit-bearing tokens.
  s = s
    .replace(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{3}-\d{4})\b/g, " ")
    .replace(/\.(com|net|org|io|co)\b/gi, "")
    .replace(/\bwww\./gi, "");
  let tokens = s.split(/\s+/).filter((t) => t && !/\d/.test(t) && !/^[#*\-/.:,]+$/.test(t));

  // Trailing "CITY ST": drop the state and one city word, if enough is left.
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 3 && last && STATES.has(last.toUpperCase()) && last === last.toUpperCase()) {
    tokens = tokens.slice(0, -2);
  }

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
