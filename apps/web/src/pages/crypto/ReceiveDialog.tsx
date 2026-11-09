import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { CoinIcon } from "../../components/coins.js";
import { Alert } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { copyText } from "../../lib/clipboard.js";

/** Where to receive into a synced wallet: the address with a QR code (drawn in the browser). */

interface ReceiveInfo {
  chain: string;
  chainName: string;
  coin: string;
  address: string | null;
  note: string | null;
}

/** The wallet's receive address with a QR code (drawn in the browser). */
export function Receive({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["crypto", "receive", id],
    queryFn: () => api.get<ReceiveInfo>(`/api/crypto/wallets/${id}/receive`),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const address = q.data?.address;
  useEffect(() => {
    if (!address) return;
    let live = true;
    void QRCode.toDataURL(address, { margin: 1, width: 220 }).then((u) => live && setQr(u));
    return () => {
      live = false;
    };
  }, [address]);
  if (q.isError) return <Alert>{q.error.message}</Alert>;
  if (!q.data) return <p className="text-sm text-slate-500">Loading…</p>;
  const d = q.data;
  const evm = ["eth", "base", "op", "arb", "polygon", "gnosis"].includes(d.chain);
  return (
    <div className="space-y-4 text-center text-sm">
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
        <CoinIcon asset={d.coin} size="sm" />
        {d.chainName} network
      </span>
      {d.address ? (
        <>
          <p className="text-slate-500">
            Your {d.coin} address on {d.chainName}
          </p>
          <div className="flex items-center justify-center gap-2">
            <code className="break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-slate-800">
              {d.address}
            </code>
            <button
              type="button"
              aria-label="Copy address"
              onClick={() => {
                void copyText(d.address as string).then((ok) => {
                  setCopied(ok ? "Copied" : "Select it to copy");
                  setTimeout(() => setCopied(null), ok ? 1500 : 3000);
                });
              }}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
            >
              {copied ?? "Copy"}
            </button>
          </div>
          {qr && (
            <img
              src={qr}
              alt={`QR code for ${d.address}`}
              className="mx-auto rounded-lg bg-white p-2"
              width={220}
              height={220}
            />
          )}
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Send only {d.coin}
            {evm ? ` and ${d.chainName} tokens` : ""} on the {d.chainName} network to this address.
          </p>
        </>
      ) : null}
      {d.note && <p className="text-xs text-slate-500">{d.note}</p>}
    </div>
  );
}
