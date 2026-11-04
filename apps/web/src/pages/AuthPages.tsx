import type { InviteStatus } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, Button, Field } from "../components/ui.js";
import { ApiError, api } from "../lib/api.js";
import { useAcceptInvite, useLogin, useSetup } from "../lib/auth.js";

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

/** Joining a household from an invite link (/invite/<token>). */
export function InvitePage({ token }: { token: string }) {
  const status = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<InviteStatus>(`/api/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const accept = useAcceptInvite(token);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { message, fields } = errorInfo(accept.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    accept.mutate(
      { email, password, displayName: displayName || undefined },
      { onSuccess: () => window.history.replaceState(null, "", "/") },
    );
  };

  if (status.isPending)
    return (
      <AuthLayout title="Join a household" subtitle="Checking your invite…">
        {null}
      </AuthLayout>
    );
  if (!status.data?.valid)
    return (
      <AuthLayout
        title="Invite not valid"
        subtitle="This link is invalid, already used, or expired."
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Ask the person who runs this Muny for a new invite link.{" "}
          <a href="/" className="text-brand-600 underline">
            Sign in
          </a>{" "}
          if you already have an account.
        </p>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title="Join this household on Muny"
      subtitle={
        status.data.role === "viewer"
          ? "You'll be able to see everything but not change it."
          : "You'll be able to see and manage the household's finances."
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {message && !Object.keys(fields).length && <Alert>{message}</Alert>}
        <Field
          label="Your name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
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
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          hint="At least 10 characters."
        />
        <Button type="submit" className="w-full" disabled={accept.isPending}>
          {accept.isPending ? "Creating your account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
