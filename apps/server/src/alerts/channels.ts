import { createHmac } from "node:crypto";
import type { ChannelConfig, ChannelType } from "@muny/shared";
import { createTransport } from "nodemailer";
import { z } from "zod";

/**
 * Outbound notification channels. Each one is opt-in (the user adds it) and
 * only ever receives the notification text: a title, a short body and a link.
 * Never account numbers, credentials or raw provider data. Configs are stored
 * encrypted; errors are reduced to a status so URLs/tokens never reach logs.
 */

export interface OutboundMessage {
  title: string;
  body: string;
  /** Absolute link (only when MUNY_PUBLIC_URL is set). */
  url: string | null;
  severity: "info" | "warning";
  type: string;
  createdAt: number;
}

const httpUrl = z
  .string()
  .trim()
  .url("Enter a full URL, like https://example.com")
  .refine((u) => /^https?:\/\//i.test(u), "Use an http:// or https:// URL");

/** Validate and normalize a channel config; returns only the fields that type uses. */
export function parseChannelConfig(type: ChannelType, input: unknown): ChannelConfig {
  switch (type) {
    case "ntfy":
      return z
        .object({
          server: httpUrl.optional().default("https://ntfy.sh"),
          topic: z
            .string()
            .trim()
            .regex(/^[\w-]{1,64}$/, "Use letters, numbers, - and _ (up to 64)"),
          token: z.string().trim().max(200).optional(),
        })
        .parse(input);
    case "apprise":
      return z.object({ url: httpUrl }).parse(input);
    case "webhook":
      return z.object({ url: httpUrl, secret: z.string().trim().max(200).optional() }).parse(input);
    case "smtp":
      return z
        .object({
          host: z.string().trim().min(1, "Enter the SMTP server").max(200),
          port: z.coerce.number().int().min(1).max(65535).default(587),
          secure: z.boolean().default(false),
          username: z.string().trim().max(200).optional(),
          password: z.string().max(500).optional(),
          from: z.email({ message: "Enter the sender address" }),
          to: z.email({ message: "Enter where to send alerts" }),
        })
        .parse(input);
  }
}

/** Safe one-line description for the UI (no secrets). */
export function channelSummary(type: ChannelType, c: ChannelConfig): string {
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : "";
    } catch {
      return "";
    }
  };
  switch (type) {
    case "ntfy":
      return `${host(c.server)} / ${c.topic ?? ""}`;
    case "apprise":
    case "webhook":
      return host(c.url);
    case "smtp":
      return c.to ?? "";
  }
}

export class ChannelError extends Error {}

const TIMEOUT_MS = 10_000;

async function post(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new ChannelError(timedOut ? "Timed out" : "Couldn't connect");
  }
  if (!res.ok) throw new ChannelError(`The server answered HTTP ${res.status}`);
}

export async function sendToChannel(
  type: ChannelType,
  config: ChannelConfig,
  msg: OutboundMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  switch (type) {
    case "ntfy": {
      // JSON publishing keeps non-ASCII titles intact.
      const server = (config.server ?? "https://ntfy.sh").replace(/\/+$/, "");
      await post(fetchImpl, server, {
        headers: {
          "content-type": "application/json",
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          topic: config.topic,
          title: msg.title,
          message: msg.body,
          priority: msg.severity === "warning" ? 4 : 3,
          tags: [msg.severity === "warning" ? "warning" : "moneybag"],
          ...(msg.url ? { click: msg.url } : {}),
        }),
      });
      return;
    }
    case "apprise":
      await post(fetchImpl, config.url as string, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: msg.title,
          body: msg.url ? `${msg.body}\n${msg.url}` : msg.body,
          type: msg.severity === "warning" ? "warning" : "info",
        }),
      });
      return;
    case "webhook": {
      const body = JSON.stringify({
        event: "muny.notification",
        type: msg.type,
        severity: msg.severity,
        title: msg.title,
        body: msg.body,
        url: msg.url,
        createdAt: new Date(msg.createdAt).toISOString(),
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.secret)
        headers["x-muny-signature"] =
          `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
      await post(fetchImpl, config.url as string, { headers, body });
      return;
    }
    case "smtp": {
      const transport = createTransport({
        host: config.host,
        port: config.port ?? 587,
        secure: config.secure ?? false,
        auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
      try {
        await transport.sendMail({
          from: config.from,
          to: config.to,
          subject: `Muny: ${msg.title}`,
          text: msg.url ? `${msg.body}\n\n${msg.url}` : msg.body,
        });
      } catch (err) {
        const code = (err as { code?: string; responseCode?: number }) ?? {};
        throw new ChannelError(
          code.responseCode
            ? `The mail server answered ${code.responseCode}`
            : code.code === "EAUTH"
              ? "The mail server rejected the username or password"
              : "Couldn't send the email",
        );
      } finally {
        transport.close();
      }
    }
  }
}
