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
  "trial_ending",
  "agent_proposal",
  "ai_review",
  "ai_checkin",
  "api_limit",
  "price_alert",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Alerts set on each account (Accounts page), not globally. */
export const ACCOUNT_ALERT_TYPES: readonly AlertType[] = [
  "low_balance",
  "large_transaction",
  "unusual_charge",
  "duplicate_charge",
];

/** An account's alerts: thresholds in cents (null = off). */
export interface AccountAlertSettings {
  lowBalanceCents: number | null;
  largeChargeCents: number | null;
  unusualCharge: boolean;
  duplicateCharge: boolean;
}

export const DEFAULT_ACCOUNT_ALERTS: AccountAlertSettings = {
  lowBalanceCents: null,
  largeChargeCents: null,
  unusualCharge: true,
  duplicateCharge: true,
};

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
  /** bill_due / trial_ending: this many days before (older setting; see reminderDays). */
  daysBefore?: number;
  /** bill_due / trial_ending: remind at each of these many days before (e.g. [7, 1]). */
  reminderDays?: number[];
  /** budget: alert at these percentages of a budget (e.g. [80, 100]). */
  percents?: number[];
  /** budget: categories that never alert ("total" for the total spending budget). */
  mutedCategoryIds?: string[];
}

export interface AlertRule {
  id: string;
  type: AlertType;
  enabled: boolean;
  params: AlertParams;
  channelIds: string[];
}

export const CHANNEL_TYPES = ["ntfy", "apprise", "smtp", "webhook", "push"] as const;
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
  /** push (this device's notifications): the browser's subscription */
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  /** push: which device, e.g. "Android · Chrome" */
  device?: string;
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
