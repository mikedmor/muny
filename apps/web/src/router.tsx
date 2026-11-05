import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.js";
import { Alert, Button } from "./components/ui.js";
import { useAuthStatus } from "./lib/auth.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { InvitePage, LoginPage, SetupPage } from "./pages/AuthPages.js";
import { BudgetsPage } from "./pages/BudgetsPage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { NotificationsPage } from "./pages/NotificationsPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PlaidOAuthPage } from "./pages/PlaidOAuthPage.js";
import { RecurringPage } from "./pages/RecurringPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
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

const routeTree = rootRoute.addChildren([
  page("/", OverviewPage),
  page("/transactions", TransactionsPage),
  page("/alerts", NotificationsPage),
  page("/recurring", RecurringPage),
  page("/budgets", BudgetsPage),
  page("/reports", ReportsPage),
  page("/accounts", AccountsPage),
  page("/import", ImportPage),
  page("/settings", SettingsPage),
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
