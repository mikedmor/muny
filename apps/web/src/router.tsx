import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.js";
import { Alert, Button } from "./components/ui.js";
import { useAuthStatus } from "./lib/auth.js";
import { validateTransactionSearch } from "./lib/search.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { AskPage } from "./pages/AskPage.js";
import { AssetsPage } from "./pages/AssetsPage.js";
import { InvitePage, LoginPage, SetupPage } from "./pages/AuthPages.js";
import { BudgetsPage } from "./pages/BudgetsPage.js";
import { CardEditorPage } from "./pages/CardEditorPage.js";
import { CardsPage } from "./pages/CardsPage.js";
import { CategoryPage } from "./pages/CategoryPage.js";
import { ContractReviewPage } from "./pages/ContractReviewPage.js";
import { CustomizePage } from "./pages/CustomizePage.js";
import { CoinPage } from "./pages/crypto/CoinPage.js";
import { CryptoDashboard } from "./pages/crypto/CryptoDashboard.js";
import { CryptoReconcile } from "./pages/crypto/CryptoReconcile.js";
import { CryptoSettings } from "./pages/crypto/CryptoSettings.js";
import { CryptoTransactions } from "./pages/crypto/CryptoTransactions.js";
import { CryptoWalletPage } from "./pages/crypto/CryptoWalletPage.js";
import { CryptoWallets } from "./pages/crypto/CryptoWallets.js";
import { DocumentsPage } from "./pages/DocumentsPage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { LoansPage } from "./pages/LoansPage.js";
import { NotificationsPage } from "./pages/NotificationsPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PlaidOAuthPage } from "./pages/PlaidOAuthPage.js";
import { RecurringPage } from "./pages/RecurringPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { SavingsPage } from "./pages/SavingsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SpendingPage } from "./pages/SpendingPage.js";
import { StockDetailPage } from "./pages/StockDetailPage.js";
import { StocksPage } from "./pages/StocksPage.js";
import { TaxesPage } from "./pages/TaxesPage.js";
import { ThemeEditorPage } from "./pages/ThemeEditorPage.js";
import { TransactionsPage } from "./pages/TransactionsPage.js";

/** Root: decides between first-run setup, sign-in, and the app. */
function Root() {
  const status = useAuthStatus();
  if (status.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-slate-500">Loading…</div>
    );
  }
  if (status.isError) {
    return (
      <div className="mx-auto mt-20 max-w-md space-y-3 px-4">
        <Alert>Can't reach the Muny server.</Alert>
        <Button variant="secondary" onClick={() => status.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (status.data.setupRequired) return <SetupPage />;
  const invite = /^\/invite\/([\w-]{20,100})$/.exec(window.location.pathname);
  if (!status.data.user && invite?.[1]) return <InvitePage token={invite[1]} />;
  if (!status.data.user) return <LoginPage />;
  return <AppShell user={status.data.user} />;
}

const rootRoute = createRootRoute({ component: Root });

const page = <const P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

/** A route whose URL search params are validated (e.g. transaction filters). */
const searchPage = <const P extends string, S>(
  path: P,
  component: () => React.ReactNode,
  validateSearch: (s: Record<string, unknown>) => S,
) => createRoute({ getParentRoute: () => rootRoute, path, component, validateSearch });

const monthSearch = (s: Record<string, unknown>): { month?: string } =>
  typeof s.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) ? { month: s.month } : {};

const cryptoTxnSearch = (s: Record<string, unknown>) => {
  const out: Record<string, string | number> = {};
  for (const k of ["walletId", "asset", "type", "label", "from", "to", "warnings"])
    if (typeof s[k] === "string" && (s[k] as string).length <= (k === "walletId" ? 4000 : 64))
      out[k] = s[k] as string;
  if (typeof s.page === "number" && s.page > 0) out.page = Math.floor(s.page);
  return out as {
    walletId?: string;
    warnings?: "missing" | "duplicates";
    asset?: string;
    type?: "deposit" | "withdrawal" | "trade" | "transfer";
    label?: string;
    from?: string;
    to?: string;
    page?: number;
  };
};

const themeSearch = (s: Record<string, unknown>): { from?: string } =>
  typeof s.from === "string" && s.from.length <= 64 ? { from: s.from } : {};

const routeTree = rootRoute.addChildren([
  page("/", OverviewPage),
  page("/overview/customize", CustomizePage),
  searchPage("/overview/cards/$cardId", CardEditorPage, themeSearch),
  searchPage("/transactions", TransactionsPage, validateTransactionSearch),
  searchPage("/categories/$categoryId", CategoryPage, monthSearch),
  page("/alerts", NotificationsPage),
  page("/recurring", RecurringPage),
  page("/spending", SpendingPage),
  page("/savings", SavingsPage),
  page("/budgets", BudgetsPage),
  page("/loans", LoansPage),
  page("/cards", CardsPage),
  page("/assets", AssetsPage),
  page("/ask", AskPage),
  page("/reports", ReportsPage),
  page("/taxes", TaxesPage),
  page("/documents", DocumentsPage),
  page("/documents/$documentId/review", ContractReviewPage),
  page("/stocks", StocksPage),
  page("/stocks/$symbol", StockDetailPage),
  page("/crypto", CryptoDashboard),
  page("/crypto/coins/$asset", CoinPage),
  page("/crypto/wallets", CryptoWallets),
  page("/crypto/wallets/$walletId", CryptoWalletPage),
  searchPage("/crypto/transactions", CryptoTransactions, cryptoTxnSearch),
  page("/crypto/reconcile", CryptoReconcile),
  page("/crypto/settings", CryptoSettings),
  page("/accounts", AccountsPage),
  page("/import", ImportPage),
  page("/settings", SettingsPage),
  searchPage("/settings/themes/$themeId", ThemeEditorPage, themeSearch),
  page("/oauth/plaid", PlaidOAuthPage),
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => <p className="text-slate-500">Page not found.</p>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
