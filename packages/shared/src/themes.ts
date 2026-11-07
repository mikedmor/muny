/**
 * Themes. A theme is a small set of colors; everything else (Tailwind's gray
 * ramp, the brand ramp, chart tokens) is worked out from them. Pages and cards
 * only ever use the resulting CSS variables, so they follow the theme without
 * knowing about it. Colors are validated hex values, never free text, so a
 * theme (even one pasted from elsewhere) can't inject anything.
 */

export const THEME_MODES = ["light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const CHART_COLOR_KEYS = [
  "chart1",
  "chart2",
  "chart3",
  "chart4",
  "chart5",
  "chart6",
  "chart7",
  "chart8",
] as const;

export const THEME_COLOR_KEYS = [
  "background",
  "surface",
  "border",
  "text",
  "muted",
  "primary",
  "positive",
  "negative",
  "warning",
  ...CHART_COLOR_KEYS,
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Record<ThemeColorKey, string>;

export const THEME_COLOR_LABELS: Record<ThemeColorKey, { label: string; hint: string }> = {
  background: { label: "Page background", hint: "Behind everything." },
  surface: { label: "Cards & menus", hint: "Cards, the sidebar, dialogs." },
  border: { label: "Lines & borders", hint: "Dividers, outlines, gridlines." },
  text: { label: "Text", hint: "Headings and body text." },
  muted: { label: "Quiet text", hint: "Labels and secondary text." },
  primary: { label: "Accent", hint: "Buttons, links, the active menu item." },
  positive: { label: "Good", hint: "Money in, under budget." },
  negative: { label: "Bad", hint: "Over budget, errors, delete." },
  warning: { label: "Warning", hint: "Things that need a look." },
  chart1: { label: "Chart 1", hint: "First series in every chart." },
  chart2: { label: "Chart 2", hint: "" },
  chart3: { label: "Chart 3", hint: "" },
  chart4: { label: "Chart 4", hint: "" },
  chart5: { label: "Chart 5", hint: "" },
  chart6: { label: "Chart 6", hint: "" },
  chart7: { label: "Chart 7", hint: "" },
  chart8: { label: "Chart 8", hint: "" },
};

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
}

/** Create or replace a custom theme. */
export type ThemeInput = Omit<Theme, "id">;

/** The saved choice: a theme id, or "system" to follow the device's light or dark setting. */
export const SYSTEM_THEME = "system";

export interface ThemeState {
  /** This person's choice. */
  selected: string;
  /** Themes made in this household. */
  custom: Theme[];
}

export const MAX_CUSTOM_THEMES = 50;
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Chart palettes checked with the dataviz validator against their surfaces. */
const LIGHT_CHARTS = {
  chart1: "#2a78d6",
  chart2: "#eb6834",
  chart3: "#1baf7a",
  chart4: "#eda100",
  chart5: "#e87ba4",
  chart6: "#008300",
  chart7: "#6250d6",
  chart8: "#e34948",
};
const DARK_CHARTS = {
  chart1: "#3987e5",
  chart2: "#d95926",
  chart3: "#199e70",
  chart4: "#c98500",
  chart5: "#d55181",
  chart6: "#008300",
  chart7: "#9085e9",
  chart8: "#e66767",
};

export const STANDARD_LIGHT = "light";
export const STANDARD_DARK = "dark";

export const BUILTIN_THEMES: Theme[] = [
  {
    id: STANDARD_LIGHT,
    name: "Light",
    mode: "light",
    colors: {
      background: "#f8fafc",
      surface: "#ffffff",
      border: "#e2e8f0",
      text: "#0f172a",
      muted: "#64748b",
      primary: "#0d9488",
      positive: "#059669",
      negative: "#dc2626",
      warning: "#d97706",
      ...LIGHT_CHARTS,
    },
  },
  {
    id: STANDARD_DARK,
    name: "Dark",
    mode: "dark",
    colors: {
      background: "#020617",
      surface: "#0f172a",
      border: "#1e293b",
      text: "#f1f5f9",
      muted: "#64748b",
      primary: "#0d9488",
      positive: "#10b981",
      negative: "#ef4444",
      warning: "#f59e0b",
      ...DARK_CHARTS,
    },
  },
  {
    id: "sand",
    name: "Sand",
    mode: "light",
    colors: {
      background: "#f6f1e7",
      surface: "#fffdf8",
      border: "#e5dccb",
      text: "#2b2418",
      muted: "#6f6350",
      primary: "#a8551f",
      positive: "#3d7f46",
      negative: "#c0392b",
      warning: "#b7791f",
      ...LIGHT_CHARTS,
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    mode: "light",
    colors: {
      background: "#eef5fb",
      surface: "#ffffff",
      border: "#d4e3f0",
      text: "#0f2a3f",
      muted: "#526a7e",
      primary: "#1670c2",
      positive: "#0f8a6a",
      negative: "#d43f3f",
      warning: "#c77f12",
      ...LIGHT_CHARTS,
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    mode: "dark",
    colors: {
      background: "#0b1020",
      surface: "#131a2e",
      border: "#252f4a",
      text: "#e8ecf8",
      muted: "#8b97b5",
      primary: "#5b6cf0",
      positive: "#34c38f",
      negative: "#f0616d",
      warning: "#f0b429",
      ...DARK_CHARTS,
    },
  },
  {
    id: "forest",
    name: "Forest",
    mode: "dark",
    colors: {
      background: "#0a130f",
      surface: "#121e18",
      border: "#223329",
      text: "#e6f0ea",
      muted: "#86a093",
      primary: "#2f8f64",
      positive: "#4cc38a",
      negative: "#e5674f",
      warning: "#d9a53a",
      ...DARK_CHARTS,
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    mode: "dark",
    colors: {
      background: "#0e0e10",
      surface: "#18181b",
      border: "#2a2a2e",
      text: "#f4f4f5",
      muted: "#8e8e96",
      primary: "#7c5cdb",
      positive: "#3fb97c",
      negative: "#ee5d5d",
      warning: "#e3a22e",
      ...DARK_CHARTS,
    },
  },
  {
    id: "high-contrast",
    name: "High contrast",
    mode: "dark",
    colors: {
      background: "#000000",
      surface: "#0a0a0a",
      border: "#6b6b6b",
      text: "#ffffff",
      muted: "#c8c8c8",
      primary: "#0a84d6",
      positive: "#3ddc84",
      negative: "#ff6b6b",
      warning: "#ffc53d",
      ...DARK_CHARTS,
    },
  },
];

export const findTheme = (id: string, custom: Theme[] = []) =>
  BUILTIN_THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? null;

/** The theme to show for a choice. An unknown id (a deleted theme) follows the device. */
export function resolveTheme(selected: string, custom: Theme[], prefersDark: boolean): Theme {
  const found = selected === SYSTEM_THEME ? null : findTheme(selected, custom);
  if (found) return found;
  return findTheme(prefersDark ? STANDARD_DARK : STANDARD_LIGHT) as Theme;
}

// ---------------------------------------------------------------------------
// Color math, in OKLab so mixes stay even to the eye. Display only.
// ---------------------------------------------------------------------------

type Lab = [number, number, number];

function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToLinear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    const c = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)}${channel(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
  )}${channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)}`;
}

/** `amount` of the way from a to b. */
export function mixColors(a: string, b: string, amount: number): string {
  const x = hexToLab(a);
  const y = hexToLab(b);
  return labToHex([
    x[0] + (y[0] - x[0]) * amount,
    x[1] + (y[1] - x[1]) * amount,
    x[2] + (y[2] - x[2]) * amount,
  ]);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToLinear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on a button of this color: white while that stays readable, else near-black. */
export function readableOn(color: string): string {
  return contrastRatio(color, "#ffffff") >= 3 ? "#ffffff" : "#0b0b0b";
}

const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** A meaning color (good, bad, warning) as a full light-to-dark ramp around it. */
function meaningRamp(color: string): Record<number, string> {
  const white = "#ffffff";
  const black = "#000000";
  return {
    50: mixColors(color, white, 0.92),
    100: mixColors(color, white, 0.85),
    200: mixColors(color, white, 0.7),
    300: mixColors(color, white, 0.5),
    400: mixColors(color, white, 0.25),
    500: color,
    600: mixColors(color, black, 0.12),
    700: mixColors(color, black, 0.28),
    800: mixColors(color, black, 0.42),
    900: mixColors(color, black, 0.55),
    950: mixColors(color, black, 0.72),
  };
}

/** The gray ramp pages use, running from the theme's background to its text. */
function grayRamp(c: ThemeColors, mode: ThemeMode): Record<number, string> {
  const toMuted = (n: number) => mixColors(c.border, c.muted, n);
  const toText = (n: number) => mixColors(c.muted, c.text, n);
  if (mode === "dark")
    return {
      50: mixColors(c.text, "#ffffff", 0.4),
      100: c.text,
      200: toText(0.85),
      300: toText(0.66),
      400: toText(0.33),
      500: c.muted,
      600: toMuted(0.66),
      700: toMuted(0.33),
      800: c.border,
      900: c.surface,
      950: c.background,
    };
  return {
    50: c.background,
    100: mixColors(c.background, c.border, 0.5),
    200: c.border,
    300: toMuted(0.25),
    400: toMuted(0.66),
    500: c.muted,
    600: toText(0.33),
    700: toText(0.55),
    800: toText(0.8),
    900: c.text,
    950: mixColors(c.text, "#000000", 0.3),
  };
}

// Tailwind's own ramps. The two standard themes use them exactly, and they have
// to be spelled out so a preview of a standard theme looks right inside any other.
const SLATE = [
  "oklch(98.4% 0.003 247.858)",
  "oklch(96.8% 0.007 247.896)",
  "oklch(92.9% 0.013 255.508)",
  "oklch(86.9% 0.022 252.894)",
  "oklch(70.4% 0.04 256.788)",
  "oklch(55.4% 0.046 257.417)",
  "oklch(44.6% 0.043 257.281)",
  "oklch(37.2% 0.044 257.287)",
  "oklch(27.9% 0.041 260.031)",
  "oklch(20.8% 0.042 265.755)",
  "oklch(12.9% 0.042 264.695)",
];
const EMERALD = [
  "oklch(97.9% 0.021 166.113)",
  "oklch(95% 0.052 163.051)",
  "oklch(90.5% 0.093 164.15)",
  "oklch(84.5% 0.143 164.978)",
  "oklch(76.5% 0.177 163.223)",
  "oklch(69.6% 0.17 162.48)",
  "oklch(59.6% 0.145 163.225)",
  "oklch(50.8% 0.118 165.612)",
  "oklch(43.2% 0.095 166.913)",
  "oklch(37.8% 0.077 168.94)",
  "oklch(26.2% 0.051 172.552)",
];
const RED = [
  "oklch(97.1% 0.013 17.38)",
  "oklch(93.6% 0.032 17.717)",
  "oklch(88.5% 0.062 18.334)",
  "oklch(80.8% 0.114 19.571)",
  "oklch(70.4% 0.191 22.216)",
  "oklch(63.7% 0.237 25.331)",
  "oklch(57.7% 0.245 27.325)",
  "oklch(50.5% 0.213 27.518)",
  "oklch(44.4% 0.177 26.899)",
  "oklch(39.6% 0.141 25.723)",
  "oklch(25.8% 0.092 26.042)",
];
const AMBER = [
  "oklch(98.7% 0.022 95.277)",
  "oklch(96.2% 0.059 95.617)",
  "oklch(92.4% 0.12 95.746)",
  "oklch(87.9% 0.169 91.605)",
  "oklch(82.8% 0.189 84.429)",
  "oklch(76.9% 0.188 70.08)",
  "oklch(66.6% 0.179 58.318)",
  "oklch(55.5% 0.163 48.998)",
  "oklch(47.3% 0.137 46.201)",
  "oklch(41.4% 0.112 45.904)",
  "oklch(27.9% 0.077 45.635)",
];

function setRamp(
  vars: Record<string, string>,
  name: string,
  values: readonly string[] | Record<number, string>,
) {
  RAMP_STEPS.forEach((step, i) => {
    const v = Array.isArray(values)
      ? (values as readonly string[])[i]
      : (values as Record<number, string>)[step];
    if (v) vars[`--color-${name}-${step}`] = v;
  });
}

/** Every CSS variable a theme sets. Apply them to any element to theme what's inside it. */
export function themeVariables(theme: Theme): Record<string, string> {
  const c = theme.colors;
  const vars: Record<string, string> = {};
  const standard = theme.id === STANDARD_LIGHT || theme.id === STANDARD_DARK;
  const dark = theme.mode === "dark";

  if (standard) {
    setRamp(vars, "slate", SLATE);
    setRamp(vars, "emerald", EMERALD);
    setRamp(vars, "red", RED);
    setRamp(vars, "amber", AMBER);
    vars["--color-brand-50"] = "#f0fdfa";
    vars["--color-brand-500"] = "#14b8a6";
    vars["--color-brand-600"] = "#0d9488";
    vars["--color-brand-700"] = "#0f766e";
    vars["--color-on-brand"] = "#ffffff";
    vars["--color-surface"] = dark ? (SLATE[9] ?? c.surface) : "#ffffff";
  } else {
    setRamp(vars, "slate", grayRamp(c, theme.mode));
    setRamp(vars, "emerald", meaningRamp(c.positive));
    setRamp(vars, "red", meaningRamp(c.negative));
    setRamp(vars, "amber", meaningRamp(c.warning));
    vars["--color-brand-50"] = mixColors(c.primary, c.surface, 0.88);
    vars["--color-brand-500"] = mixColors(c.primary, dark ? "#ffffff" : c.surface, 0.2);
    vars["--color-brand-600"] = c.primary;
    vars["--color-brand-700"] = mixColors(c.primary, dark ? "#ffffff" : "#000000", 0.18);
    vars["--color-on-brand"] = readableOn(c.primary);
    vars["--color-surface"] = c.surface;
  }

  vars["--viz-surface"] = c.surface;
  vars["--viz-ink"] = c.text;
  vars["--viz-ink-2"] = mixColors(c.muted, c.text, 0.55);
  vars["--viz-muted"] = c.muted;
  vars["--viz-grid"] = c.border;
  vars["--viz-axis"] = mixColors(c.border, c.muted, 0.3);
  vars["--viz-deemph"] = mixColors(c.border, c.muted, 0.45);
  vars["--viz-other"] = mixColors(c.border, c.muted, 0.6);
  vars["--viz-positive"] = c.positive;
  vars["--viz-negative"] = c.negative;
  vars["--viz-warning"] = c.warning;
  CHART_COLOR_KEYS.forEach((key, i) => {
    vars[`--viz-series-${i + 1}`] = c[key];
  });
  return vars;
}

export interface ThemeWarning {
  colors: ThemeColorKey[];
  message: string;
}

/** Combinations people would struggle to read. Warnings only: it's your theme. */
export function themeWarnings(theme: Pick<Theme, "colors">): ThemeWarning[] {
  const c = theme.colors;
  const out: ThemeWarning[] = [];
  const check = (
    keys: ThemeColorKey[],
    a: string,
    b: string,
    min: number,
    what: (ratio: string) => string,
  ) => {
    const r = contrastRatio(a, b);
    if (r < min) out.push({ colors: keys, message: what(r.toFixed(1)) });
  };
  check(
    ["text", "surface"],
    c.text,
    c.surface,
    4.5,
    (r) => `Text is hard to read on cards (contrast ${r}:1, aim for at least 4.5:1).`,
  );
  check(
    ["text", "background"],
    c.text,
    c.background,
    4.5,
    (r) => `Text is hard to read on the page background (contrast ${r}:1).`,
  );
  check(
    ["muted", "surface"],
    c.muted,
    c.surface,
    3,
    (r) => `Quiet text is hard to read on cards (contrast ${r}:1, aim for at least 3:1).`,
  );
  check(
    ["primary", "surface"],
    c.primary,
    c.surface,
    3,
    (r) => `The accent doesn't stand out from cards (contrast ${r}:1).`,
  );
  for (const key of CHART_COLOR_KEYS)
    check(
      [key, "surface"],
      c[key],
      c.surface,
      1.5,
      (r) => `${THEME_COLOR_LABELS[key].label} nearly disappears on cards (contrast ${r}:1).`,
    );
  return out;
}
