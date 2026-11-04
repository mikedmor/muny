/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded
 * newlines, CRLF/LF, optional UTF-8 BOM, and comma/semicolon/tab delimiters.
 * Bank exports are small enough that a dependency isn't worth it.
 */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty lines.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n/) >>> 0 || text.length);
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]?.[1] ? counts[0][0] : ",";
}

/** Parse CSV with a header row into objects keyed by trimmed header names. */
export function parseCsvRecords(input: string): {
  headers: string[];
  records: { line: number; values: Record<string, string> }[];
} {
  const rows = parseCsv(input);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      values[h] = (r[i] ?? "").trim();
    });
    return { line: idx + 2, values };
  });
  return { headers, records };
}
