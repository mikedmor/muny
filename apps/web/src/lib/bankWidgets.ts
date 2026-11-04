/**
 * Loaders for the bank widgets. Plaid Link and Teller Connect must be loaded
 * from their own CDNs (they can't be bundled); the server's CSP only allows
 * these hosts when that provider is configured.
 */

const PLAID_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const TELLER_SRC = "https://cdn.teller.io/connect/connect.js";

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(
          new Error("Couldn't load the bank connection widget. Check your internet connection."),
        );
      };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
  }
  return p;
}

interface PlaidHandler {
  open: () => void;
  exit: (opts?: { force?: boolean }) => void;
  destroy: () => void;
}

interface PlaidGlobal {
  create: (opts: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: unknown) => void;
    onExit?: (err: { display_message?: string | null; error_message?: string } | null) => void;
  }) => PlaidHandler;
}

export interface TellerEnrollment {
  accessToken: string;
  enrollment: { id: string; institution?: { name?: string } };
}

interface TellerGlobal {
  setup: (opts: {
    applicationId: string;
    environment: string;
    products: string[];
    enrollmentId?: string;
    selectAccount?: "disabled" | "single" | "multiple";
    onSuccess: (e: TellerEnrollment) => void;
    onExit?: () => void;
    onFailure?: (f: { message?: string }) => void;
  }) => { open: () => void };
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal;
    TellerConnect?: TellerGlobal;
  }
}

const OAUTH_KEY = "muny.plaid.linkToken";

/** Open Plaid Link. Resolves with the public token, or null if the user closed it. */
export async function openPlaidLink(
  linkToken: string,
  receivedRedirectUri?: string,
): Promise<string | null> {
  await loadScript(PLAID_SRC);
  const Plaid = window.Plaid;
  if (!Plaid) throw new Error("Plaid Link didn't load");
  // OAuth banks bounce through the bank's site and back to /oauth/plaid; keep the token for that.
  try {
    sessionStorage.setItem(OAUTH_KEY, linkToken);
  } catch {
    // Private mode etc.: OAuth banks just won't resume.
  }
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (publicToken) => {
        handler.destroy();
        resolve(publicToken);
      },
      onExit: (err) => {
        handler.destroy();
        if (err)
          reject(
            new Error(
              err.display_message || err.error_message || "Plaid Link closed with an error",
            ),
          );
        else resolve(null);
      },
    });
    handler.open();
  });
}

export function takeStoredPlaidLinkToken(): string | null {
  try {
    const t = sessionStorage.getItem(OAUTH_KEY);
    sessionStorage.removeItem(OAUTH_KEY);
    return t;
  } catch {
    return null;
  }
}

/** Open Teller Connect. Resolves with the enrollment, or null if closed. */
export async function openTellerConnect(opts: {
  applicationId: string;
  environment: string;
  enrollmentId?: string;
}): Promise<TellerEnrollment | null> {
  await loadScript(TELLER_SRC);
  const Teller = window.TellerConnect;
  if (!Teller) throw new Error("Teller Connect didn't load");
  return new Promise((resolve, reject) => {
    Teller.setup({
      applicationId: opts.applicationId,
      environment: opts.environment,
      products: ["transactions", "balance"],
      selectAccount: "multiple",
      ...(opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}),
      onSuccess: (e) => resolve(e),
      onExit: () => resolve(null),
      onFailure: (f) => reject(new Error(f.message || "Teller Connect failed")),
    }).open();
  });
}
