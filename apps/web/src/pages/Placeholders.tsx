import { Card, PageHeader } from "../components/ui.js";

function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <p className="text-sm text-slate-600 dark:text-slate-400">{text}</p>
      </Card>
    </>
  );
}

export const OverviewPage = () => (
  <ComingSoon
    title="Overview"
    text="Your spending summary, upcoming bills and subscriptions will appear here once data is imported."
  />
);
export const TransactionsPage = () => (
  <ComingSoon
    title="Transactions"
    text="Transaction list, search and editing are coming next in Phase 1."
  />
);
export const AccountsPage = () => (
  <ComingSoon
    title="Accounts"
    text="Add manual accounts here, or create them automatically via import."
  />
);
export const ImportPage = () => (
  <ComingSoon title="Import" text="CSV, OFX/QFX and Rocket Money imports are coming in Phase 1." />
);
export const SettingsPage = () => (
  <ComingSoon title="Settings" text="Categories, rules, backups and export will live here." />
);
