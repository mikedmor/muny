/** Alerts & notifications DTOs. Amounts are integer cents. */

export const ALERT_TYPES = [
  "low_balance",
  "large_transaction",
  "unusual_charge",
  "duplicate_charge",
  "bill_due",
  "price_increase",
  "budget",
  "charged_after_cancel",
  "connection_error",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Parameters per alert type (all optional; defaults apply). */
export interface AlertParams {
  /** low_balance: alert when a checking/savings balance drops below this. */
  thresholdCents?: number;
  /** low_balance: only these accounts (empty = all checking & savings). */
  accountIds?: string[];
  /** large_transaction: money out at or above this. */
  minCents?: number;
  /** unusual_charge: this many times the merchant's typical charge. */
  multiplier?: number;
  /** duplicate_charge: same merchant & amount within this many days. */
  days?: number;
  /** bill_due: this many days before the expected date. */
  daysBefore?: number;
  /** budget: alert at these percentages of a budget (e.g. [80, 100]). */
  percents?: number[];
}

export interface AlertRule {
  id: string;
  type: AlertType;
  enabled: boolean;
  params: AlertParams;
  channelIds: string[];
}

export const CHANNEL_TYPES = ["ntfy", "apprise", "smtp", "webhook"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** What's sent when creating/updating a channel. Secrets are write-only. */
export interface ChannelConfig {
  /** ntfy: server URL (default https://ntfy.sh) */
  server?: string;
  /** ntfy: topic */
  topic?: string;
  /** ntfy: access token (optional) */
  token?: string;
  /** apprise / webhook: endpoint URL */
  url?: string;
  /** webhook: shared secret for the X-Muny-Signature HMAC (optional) */
  secret?: string;
  /** smtp */
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from?: string;
  to?: string;
}

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** Non-secret summary, e.g. "ntfy.sh / my-topic" or "you@example.com". */
  summary: string;
  lastSentAt: number | null;
  lastError: string | null;
}

export interface AppNotification {
  id: string;
  ruleType: string;
  severity: "info" | "warning";
  title: string;
  body: string;
  link: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationList {
  items: AppNotification[];
  unread: number;
}
