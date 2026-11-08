import { parseAnyKoinlyCsv, parseBrokerageCsv } from "@muny/core";
import type { ImportFileKind } from "@muny/shared";
import { detectFormat } from "./service.js";

/**
 * Which importer a text file belongs to, so the Import page can take any file:
 * bank transactions (CSV, OFX/QFX, a Rocket Money export), a brokerage export
 * (positions or trades) or a crypto export (Koinly). Nothing is saved here.
 */
export function detectImportFile(content: string, filename = ""): ImportFileKind {
  const format = detectFormat({ content, filename });
  if (format === "ofx") return { kind: "transactions", label: "Bank file (OFX/QFX)" };
  if (format === "rocket_money") return { kind: "transactions", label: "Rocket Money export" };
  try {
    const k = parseAnyKoinlyCsv(content);
    if (k.txns.length > 0) return { kind: "crypto", label: "Koinly crypto export" };
  } catch {
    // Not Koinly.
  }
  try {
    const b = parseBrokerageCsv(content);
    // Trades name a security; a bank CSV with a "type" column doesn't.
    const trades = b.activity.filter((a) => a.symbol || a.quantity).length;
    if (b.positions.length > 0 || trades > 0)
      return { kind: "brokerage", label: `${b.broker} export` };
  } catch {
    // Not a brokerage file.
  }
  return { kind: "transactions", label: "Bank or card CSV" };
}
