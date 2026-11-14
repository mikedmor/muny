/**
 * Home Assistant (D-091): the sensors Muny offers at /api/v1/home-assistant
 * and the configuration.yaml that reads them with HA's REST integration.
 */
import type { AgentScope } from "./agents.js";

export interface HaSensor {
  key: string;
  name: string;
  scope: AgentScope;
  /** A money amount (unit USD, device class monetary). */
  money?: boolean;
  unit?: string;
  deviceClass?: "date";
  icon?: string;
}

export const HA_SENSORS: HaSensor[] = [
  {
    key: "spent_this_month",
    name: "Spent this month",
    scope: "read:summary",
    money: true,
    icon: "mdi:cart",
  },
  {
    key: "earned_this_month",
    name: "Earned this month",
    scope: "read:summary",
    money: true,
    icon: "mdi:cash-plus",
  },
  {
    key: "budget_left",
    name: "Budget left",
    scope: "read:summary",
    money: true,
    icon: "mdi:target",
  },
  {
    key: "budget_used_pct",
    name: "Budget used",
    scope: "read:summary",
    unit: "%",
    icon: "mdi:percent",
  },
  {
    key: "bills_due_7_days",
    name: "Bills due in 7 days",
    scope: "read:summary",
    money: true,
    icon: "mdi:calendar-alert",
  },
  { key: "next_bill", name: "Next bill", scope: "read:summary", icon: "mdi:receipt-text" },
  { key: "next_bill_date", name: "Next bill date", scope: "read:summary", deviceClass: "date" },
  { key: "unread_alerts", name: "Unread alerts", scope: "read:summary", icon: "mdi:bell" },
  {
    key: "net_worth",
    name: "Net worth",
    scope: "read:accounts",
    money: true,
    icon: "mdi:scale-balance",
  },
  { key: "cash", name: "Cash", scope: "read:accounts", money: true, icon: "mdi:bank" },
  {
    key: "forecast_lowest",
    name: "Lowest balance ahead",
    scope: "read:accounts",
    money: true,
    icon: "mdi:chart-line-variant",
  },
  {
    key: "forecast_lowest_date",
    name: "Lowest balance date",
    scope: "read:accounts",
    deviceClass: "date",
  },
];

/** The configuration.yaml block for HA's REST integration (the token goes in secrets.yaml). */
export function haYaml(opts: { url: string; scopes: AgentScope[]; scanSeconds?: number }): string {
  const sensors = HA_SENSORS.filter((s) => opts.scopes.includes(s.scope));
  const lines = [
    "rest:",
    `  - resource: ${opts.url.replace(/\/+$/, "")}/api/v1/home-assistant`,
    `    scan_interval: ${opts.scanSeconds ?? 900}`,
    "    headers:",
    "      Authorization: !secret muny_token",
    "    sensor:",
  ];
  for (const s of sensors) {
    lines.push(
      `      - name: "Muny ${s.name.toLowerCase()}"`,
      `        unique_id: muny_${s.key}`,
      `        value_template: "{{ value_json.${s.key} }}"`,
    );
    if (s.money) lines.push(`        unit_of_measurement: "USD"`, "        device_class: monetary");
    if (s.unit) lines.push(`        unit_of_measurement: "${s.unit}"`);
    if (s.deviceClass) lines.push(`        device_class: ${s.deviceClass}`);
    if (s.icon) lines.push(`        icon: ${s.icon}`);
  }
  if (opts.scopes.includes("read:accounts"))
    lines.push(
      "    binary_sensor:",
      `      - name: "Muny balance headed low"`,
      "        unique_id: muny_forecast_below_alert",
      `        value_template: "{{ value_json.forecast_below_alert }}"`,
      "        device_class: problem",
    );
  return `${lines.join("\n")}\n`;
}
