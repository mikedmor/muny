import { MerchantAvatar } from "./visuals.js";

/**
 * Coin logos from the open-source cryptocurrency-icons set (CC0), bundled with
 * Muny and served by your own server: no third-party image requests, so no
 * one learns which coins you hold. Each icon is a separate file, fetched only
 * when shown. Coins without an icon get the letter badge.
 */
const FILES = import.meta.glob<string>("../../node_modules/cryptocurrency-icons/svg/color/*.svg", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
});
const ICONS = new Map(
  Object.entries(FILES).map(([path, url]) => [
    (path.split("/").pop() ?? "").replace(/\.svg$/, "").toUpperCase(),
    url,
  ]),
);

/** Renamed or wrapped coins that share an older logo. */
const ALIASES: Record<string, string> = {
  POL: "MATIC",
  GLM: "GNT",
  BTTOLD: "BTT",
  XDAI: "DAI",
  CDAI: "DAI",
  WETH: "ETH",
  WBTC: "BTC",
};

export const coinIconUrl = (asset: string): string | undefined => {
  const a = asset.toUpperCase();
  return ICONS.get(a) ?? ICONS.get(ALIASES[a] ?? "");
};

export function CoinIcon({ asset, size = "md" }: { asset: string; size?: "sm" | "md" }) {
  const url = coinIconUrl(asset);
  if (!url) return <MerchantAvatar name={asset} size={size} />;
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={`shrink-0 rounded-full ring-1 ring-slate-200 dark:ring-slate-700 ${size === "sm" ? "size-7" : "size-9"}`}
    />
  );
}

const CHAIN_COIN: Record<string, string> = {
  btc: "BTC",
  ltc: "LTC",
  doge: "DOGE",
  zec: "ZEC",
  eth: "ETH",
  base: "ETH",
  arb: "ETH",
  op: "ETH",
  polygon: "POL",
  gnosis: "XDAI",
  ada: "ADA",
  algo: "ALGO",
  xlm: "XLM",
  atom: "ATOM",
  trx: "TRX",
};

/**
 * A wallet's icon: its chain's coin, else a coin named in it ("ADA Exodus",
 * "Trezor ETH"), else letters (exchanges, unknown wallets).
 */
export function WalletIcon({
  name,
  chain,
  kind,
  size = "md",
}: {
  name: string;
  chain?: string | null;
  kind?: string;
  size?: "sm" | "md";
}) {
  let coin = chain ? CHAIN_COIN[chain] : undefined;
  if (!coin && kind !== "exchange")
    coin = name
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .find((w) => w.length >= 2 && coinIconUrl(w));
  return coin ? <CoinIcon asset={coin} size={size} /> : <MerchantAvatar name={name} size={size} />;
}
