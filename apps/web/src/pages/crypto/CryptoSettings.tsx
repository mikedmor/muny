import { Link } from "@tanstack/react-router";
import { Checkbox } from "../../components/forms.js";
import { Alert, Card } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useCryptoMutation, useCryptoSettings } from "../../lib/queries.js";
import { CryptoHeader } from "./common.js";

/** How Muny treats your crypto. Outside services are under Settings → API. */

export function CryptoSettings() {
  const s = useCryptoSettings();
  const save = useCryptoMutation((body: object) => api.put("/api/crypto/settings", body));
  const d = s.data;
  return (
    <>
      <CryptoHeader />
      {s.isError && <Alert>{s.error.message}</Alert>}
      {d && (
        <div className="max-w-3xl space-y-6">
          <Card className="space-y-3">
            <h2 className="font-semibold">Cost basis and taxes</h2>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">How cost is tracked</legend>
              {(
                [
                  [
                    "us",
                    "US rules: per wallet from 2025 (recommended)",
                    "One pool across your wallets through 2024. On January 1, 2025 what's left is assigned to the wallets holding it (oldest lots first, the biggest holder first), and from then on each wallet has its own lots: a sale uses that wallet's coins, and a transfer between your wallets carries the cost and dates along (IRS Rev. Proc. 2024-28).",
                  ],
                  [
                    "universal",
                    "One pool for all wallets",
                    "Every wallet's coins in one pool, as before 2025.",
                  ],
                ] as const
              ).map(([k, label, help]) => (
                <label key={k} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="costScope"
                    className="mt-1"
                    checked={d.costScope === k}
                    onChange={() => save.mutate({ costScope: k })}
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-slate-500">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Which coins count as sold first</legend>
              {(
                [
                  [
                    "fifo",
                    "First in, first out (FIFO)",
                    "Your oldest coins go first. The usual default.",
                  ],
                  ["lifo", "Last in, first out (LIFO)", "Your newest coins go first."],
                  [
                    "hifo",
                    "Highest cost first (HIFO)",
                    "The coins that cost the most go first, which usually means the smallest taxable gains.",
                  ],
                ] as const
              ).map(([k, label, help]) => (
                <label key={k} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="costMethod"
                    className="mt-1"
                    checked={d.costMethod === k}
                    onChange={() => save.mutate({ costMethod: k })}
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-slate-500">{help}</span>
                  </span>
                </label>
              ))}
              <p className="text-xs text-slate-500">
                It changes cost basis, gains, the cost line, tax optimization and asset maturity. To
                match Koinly, pick the method in Koinly&apos;s tax settings. Long term means held
                more than a year.
              </p>
            </fieldset>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-semibold">NFTs</h2>
            <Checkbox
              label="Show NFT images"
              description="NFT images live on other sites (often IPFS). When on, your Muny server fetches them for you, so those sites see your server rather than your browser. Only links stored for your own NFTs are fetched, never addresses inside your network."
              checked={d.nftImages}
              onChange={(nftImages) => save.mutate({ nftImages })}
            />
          </Card>

          <p className="px-1 text-sm text-slate-500">
            Price providers, API keys, wallet sync servers and request limits are in{" "}
            <Link to="/settings" hash="api" className="text-brand-600 underline">
              Settings → API
            </Link>
            .
          </p>
          {save.error && <Alert>{save.error.message}</Alert>}
        </div>
      )}
    </>
  );
}
