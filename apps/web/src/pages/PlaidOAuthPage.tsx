import type { LinkStart } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { LinkAccountsForm } from "../components/BankConnections.js";
import { Alert, Card, PageHeader } from "../components/ui.js";
import { openPlaidLink, takeStoredPlaidLinkToken } from "../lib/bankWidgets.js";
import { linkApi } from "../lib/queries.js";

/**
 * Plaid OAuth return (PLAID_REDIRECT_URI should point here, e.g.
 * https://muny.example.com/oauth/plaid). Banks like Chase send the user to
 * their own site to log in, then back to this page to finish Plaid Link.
 */
export function PlaidOAuthPage() {
  const [start, setStart] = useState<LinkStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = takeStoredPlaidLinkToken();
    if (!token) {
      setError("This bank login can't be resumed in this browser tab. Start again from Accounts.");
      return;
    }
    openPlaidLink(token, window.location.href)
      .then(async (publicToken) => {
        if (!publicToken) return setDone(true);
        setStart(await linkApi.plaidExchange(publicToken));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <PageHeader title="Connecting your bank" />
      <Card className="max-w-2xl">
        {error ? (
          <Alert>{error}</Alert>
        ) : start && !done ? (
          <LinkAccountsForm start={start} onDone={() => setDone(true)} />
        ) : done ? (
          <p className="text-sm">
            All set.{" "}
            <Link to="/accounts" className="text-brand-600 underline">
              Back to accounts
            </Link>
          </p>
        ) : (
          <p className="text-sm text-slate-500">Finishing the connection…</p>
        )}
      </Card>
    </>
  );
}
