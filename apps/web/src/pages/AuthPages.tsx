import { type FormEvent, useState } from "react";
import { Alert, Button, Field } from "../components/ui.js";
import { ApiError } from "../lib/api.js";
import { useLogin, useSetup } from "../lib/auth.js";

function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {children}
        </div>
      </div>
    </div>
  );
}

function errorInfo(err: unknown) {
  if (err instanceof ApiError) return { message: err.message, fields: err.fieldErrors() };
  if (err) return { message: "Can't reach the Muny server.", fields: {} as Record<string, string> };
  return { message: undefined, fields: {} as Record<string, string> };
}

export function LoginPage() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { message, fields } = errorInfo(login.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };

  return (
    <AuthLayout title="Sign in to Muny" subtitle="Your self-hosted money manager">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {message && !Object.keys(fields).length && <Alert>{message}</Alert>}
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SetupPage() {
  const setup = useSetup();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const { message, fields } = errorInfo(setup.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setup.mutate({ email, password, displayName: displayName || undefined });
  };

  return (
    <AuthLayout title="Welcome to Muny" subtitle="Create the owner account for this installation.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {message && !Object.keys(fields).length && <Alert>{message}</Alert>}
        <Field
          label="Your name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fields.displayName}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          hint="At least 10 characters. A passphrase works well."
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? "Passwords don't match" : undefined}
        />
        <Button type="submit" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
