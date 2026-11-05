import { parseCsv } from "../import/csv.js";
import { normDec, valueCents } from "./decimal.js";

/**
 * Koinly "Transaction History" CSV export → Muny crypto transactions.
 *
 * Koinly rows have a sending and/or receiving wallet. Deposits and withdrawals
 * touch one wallet, trades (buy/sell/exchange) happen inside one wallet, and a
 * transfer between your own wallets becomes two linked transactions (out of
 * one, into the other). Koinly's own USD values, cost basis and gains are kept
 * for reference; Muny computes its own later.
 */

export type CryptoTxnType = "deposit" | "withdrawal" | "trade" | "transfer";

export interface ParsedCryptoTxn {
  /** Wallet name as Koinly calls it. */
  wallet: string;
  at: number;
  type: CryptoTxnType;
  label: string | null;
  sentAsset: string | null;
  sentAmount: string | null;
  receivedAsset: string | null;
  receivedAmount: string | null;
  feeAsset: string | null;
  feeAmount: string | null;
  valueCents: number | null;
  feeValueCents: number | null;
  importedCostBasisCents: number | null;
  importedGainCents: number | null;
  txHash: string | null;
  description: string | null;
  /** Rows sharing a transferKey are the two sides of one transfer. */
  transferKey: string | null;
  /** Source row (1-based), for error messages and stable ids. */
  line: number;
}

export interface KoinlyParseResult {
  txns: ParsedCryptoTxn[];
  wallets: { name: string; kind: "exchange" | "manual" }[];
  errors: { line: number; message: string }[];
}

const EXCHANGES =
  /coinbase|uphold|bittrex|binance|kraken|gemini|kucoin|tradeogre|bitstamp|bitfinex|crypto\.com|okx|bybit|poloniex|robinhood|cash app|paypal|gate\.io|huobi|htx|bitmart|mexc/i;

const REQUIRED = ["Date", "Type", "Sending Wallet", "Receiving Wallet"];

/** "2025-10-26 15:00:00 UTC" (or ISO) → unix ms. */
function parseKoinlyDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) throw new Error(`Unrecognized date "${s}"`);
  const [, y, mo, d, h, mi, se = "0"] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
}

const label = (tag: string) => {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  return t.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
};
const dec = (s: string | undefined) => {
  const v = (s ?? "").trim();
  return v ? normDec(v) : null;
};
const usd = (s: string | undefined) => {
  const v = (s ?? "").trim().replace(/[$,]/g, "");
  return v ? valueCents(v, "1") : null;
};
const cur = (s: string | undefined) => {
  const v = (s ?? "").trim().toUpperCase();
  return v || null;
};

export function parseKoinlyCsv(text: string): KoinlyParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  // Skip any preamble ("Koinly Transaction History…") before the header row.
  const headerAt = lines.findIndex((l) => /^"?Date"?,/.test(l) && /Sending Wallet/.test(l));
  if (headerAt < 0)
    throw new Error(
      "This doesn't look like a Koinly transaction history export (no header row found).",
    );
  const rows = parseCsv(lines.slice(headerAt).join("\n"));
  const header = rows[0] ?? [];
  const col = (name: string) => header.findIndex((h) => h.trim() === name);
  for (const r of REQUIRED)
    if (col(r) < 0) throw new Error(`The Koinly file is missing the "${r}" column.`);
  const get = (row: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? row[i] : undefined;
  };

  const txns: ParsedCryptoTxn[] = [];
  const errors: KoinlyParseResult["errors"] = [];
  const walletNames = new Set<string>();

  rows.slice(1).forEach((row, idx) => {
    const line = headerAt + idx + 2;
    if (row.every((c) => !c.trim())) return;
    try {
      const kType = (get(row, "Type") ?? "").trim().toLowerCase();
      const from = (get(row, "Sending Wallet") ?? "").trim();
      const to = (get(row, "Receiving Wallet") ?? "").trim();
      const base = {
        at: parseKoinlyDate(get(row, "Date") ?? ""),
        label: label(get(row, "Tag") ?? ""),
        sentAsset: cur(get(row, "Sent Currency")),
        sentAmount: dec(get(row, "Sent Amount")),
        receivedAsset: cur(get(row, "Received Currency")),
        receivedAmount: dec(get(row, "Received Amount")),
        feeAsset: cur(get(row, "Fee Currency")),
        feeAmount: dec(get(row, "Fee Amount")),
        valueCents: usd(get(row, "Net Value (USD)")),
        feeValueCents: usd(get(row, "Fee Value (USD)")),
        importedCostBasisCents: usd(get(row, "Sent Cost Basis")),
        importedGainCents: usd(get(row, "Gain (USD)")),
        txHash: (get(row, "TxHash") ?? "").trim() || null,
        description: (get(row, "Description") ?? "").trim() || null,
        transferKey: null as string | null,
        line,
      };
      if (from) walletNames.add(from);
      if (to) walletNames.add(to);

      if (kType === "transfer" && from && to && from !== to) {
        // Two sides of one move between your own wallets.
        const key = `t${line}`;
        txns.push({
          ...base,
          wallet: from,
          type: "transfer",
          receivedAsset: null,
          receivedAmount: null,
          transferKey: key,
        });
        txns.push({
          ...base,
          wallet: to,
          type: "transfer",
          sentAsset: null,
          sentAmount: null,
          feeAsset: null,
          feeAmount: null,
          feeValueCents: null,
          importedCostBasisCents: null,
          importedGainCents: null,
          transferKey: key,
        });
        return;
      }
      const hasSent = !!base.sentAmount;
      const hasReceived = !!base.receivedAmount;
      const type: CryptoTxnType =
        hasSent && hasReceived
          ? "trade"
          : hasReceived
            ? "deposit"
            : hasSent
              ? "withdrawal"
              : "withdrawal";
      const wallet = type === "deposit" ? to || from : from || to;
      if (!wallet) throw new Error("No wallet on this row");
      if (!hasSent && !hasReceived && !base.feeAmount) throw new Error("No amounts on this row");
      txns.push({ ...base, wallet, type });
    } catch (err) {
      errors.push({ line, message: err instanceof Error ? err.message : String(err) });
    }
  });

  return {
    txns,
    wallets: [...walletNames].map((name) => ({
      name,
      kind: EXCHANGES.test(name) ? "exchange" : "manual",
    })),
    errors,
  };
}
