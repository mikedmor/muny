import { fromBaseUnits, type SyncedTxn } from "./blockbook.js";
import { fromFixed, toFixed } from "./decimal.js";

/**
 * EVM chain history in the Etherscan-compatible "account" format (served by
 * Blockscout and others) → Muny transactions from the wallet's point of view.
 * Pure: the network client lives in the server.
 *
 * One transaction hash can move the native coin (txlist), move it through a
 * contract (txlistinternal) and move tokens (tokentx). All movements of a
 * hash are combined: one out + one in is a trade (a swap); otherwise one Muny
 * transaction per movement, with the fee on the first.
 */

export interface EsTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string | null;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  isError?: string;
  txreceipt_status?: string;
}
export interface EsInternal {
  transactionHash?: string;
  hash?: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string | null;
  value: string;
  isError?: string;
}
export interface EsTokenTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string | null;
  value: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress?: string;
}

/**
 * Airdropped scam tokens often carry URLs or sentences as their symbol. Keep
 * plain tickers only.
 */
export function plausibleSymbol(symbol: string | undefined): string | null {
  const s = (symbol ?? "").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-_$]{0,11}$/.test(s) ? s : null;
}

interface Movement {
  asset: string;
  amount: string;
  dir: "in" | "out";
}
interface Group {
  at: number;
  block: number;
  moves: Movement[];
  fee: string;
}

export function mapEvmHistory(
  address: string,
  native: { asset: string; decimals: number },
  lists: { txs: EsTx[]; internals: EsInternal[]; tokens: EsTokenTx[] },
): { txns: SyncedTxn[]; maxBlock: number } {
  const me = address.toLowerCase();
  const groups = new Map<string, Group>();
  let maxBlock = 0;
  const group = (hash: string, ts: string, block: string): Group => {
    const key = hash.toLowerCase();
    const b = Number(block) || 0;
    if (b > maxBlock) maxBlock = b;
    let g = groups.get(key);
    if (!g) {
      g = { at: Number(ts) * 1000, block: b, moves: [], fee: "0" };
      groups.set(key, g);
    }
    return g;
  };
  const move = (g: Group, from: string, to: string | null, asset: string, amount: string) => {
    if (toFixed(amount) <= 0n) return;
    const f = from.toLowerCase();
    const t = (to ?? "").toLowerCase();
    if (f === me && t !== me) g.moves.push({ asset, amount, dir: "out" });
    if (t === me && f !== me) g.moves.push({ asset, amount, dir: "in" });
  };

  for (const tx of lists.txs) {
    const g = group(tx.hash, tx.timeStamp, tx.blockNumber);
    const failed = tx.isError === "1" || tx.txreceipt_status === "0";
    if (!failed) move(g, tx.from, tx.to, native.asset, fromBaseUnits(tx.value, native.decimals));
    // We pay gas only for transactions we sent (failed ones too).
    if (tx.from.toLowerCase() === me && tx.gasUsed && tx.gasPrice)
      g.fee = fromBaseUnits((BigInt(tx.gasUsed) * BigInt(tx.gasPrice)).toString(), native.decimals);
  }
  for (const it of lists.internals) {
    if (it.isError === "1") continue;
    const hash = it.transactionHash ?? it.hash;
    if (!hash) continue;
    const g = group(hash, it.timeStamp, it.blockNumber);
    move(g, it.from, it.to, native.asset, fromBaseUnits(it.value, native.decimals));
  }
  for (const tt of lists.tokens) {
    const sym = plausibleSymbol(tt.tokenSymbol);
    if (!sym) continue;
    const g = group(tt.hash, tt.timeStamp, tt.blockNumber);
    move(g, tt.from, tt.to, sym, fromBaseUnits(tt.value, Number(tt.tokenDecimal ?? 18) || 0));
  }

  const out: SyncedTxn[] = [];
  for (const [hash, g] of groups) {
    // Net each asset per direction (e.g. two token transfers in one swap).
    const net = new Map<string, bigint>();
    for (const m of g.moves)
      net.set(m.asset, (net.get(m.asset) ?? 0n) + (m.dir === "in" ? 1n : -1n) * toFixed(m.amount));
    const ins = [...net]
      .filter(([, v]) => v > 0n)
      .map(([a, v]) => ({ asset: a, amount: fromFixed(v) }));
    const outs = [...net]
      .filter(([, v]) => v < 0n)
      .map(([a, v]) => ({ asset: a, amount: fromFixed(-v) }));
    const hasFee = toFixed(g.fee) > 0n;
    const base = {
      at: g.at,
      txHash: hash,
      feeAsset: hasFee ? native.asset : null,
      feeAmount: hasFee ? g.fee : null,
    };
    const empty = { sentAsset: null, sentAmount: null, receivedAsset: null, receivedAmount: null };
    const [o] = outs;
    const [i] = ins;
    if (outs.length === 1 && ins.length === 1 && o && i) {
      out.push({
        ...base,
        externalId: `evm:${hash}`,
        type: "trade",
        sentAsset: o.asset,
        sentAmount: o.amount,
        receivedAsset: i.asset,
        receivedAmount: i.amount,
      });
      continue;
    }
    const parts = [
      ...outs.map((m) => ({
        ...empty,
        type: "withdrawal" as const,
        sentAsset: m.asset,
        sentAmount: m.amount,
      })),
      ...ins.map((m) => ({
        ...empty,
        type: "deposit" as const,
        receivedAsset: m.asset,
        receivedAmount: m.amount,
      })),
    ];
    if (parts.length === 0) {
      // Failed call or contract interaction with no value: still costs gas.
      if (hasFee) out.push({ ...base, ...empty, externalId: `evm:${hash}`, type: "withdrawal" });
      continue;
    }
    for (const [n, p] of parts.entries())
      out.push({
        ...base,
        ...p,
        externalId: n === 0 ? `evm:${hash}` : `evm:${hash}:${n}`,
        ...(n > 0 ? { feeAsset: null, feeAmount: null } : {}),
      });
  }
  out.sort((a, b) => a.at - b.at);
  return { txns: out, maxBlock };
}
