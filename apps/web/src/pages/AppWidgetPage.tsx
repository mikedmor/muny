import { useIsFetching } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { signalWidgetReady } from "../lib/appShell.js";
import { useDashboard } from "../lib/queries.js";
import { ThemeProvider } from "../lib/theme.js";
import { useCardRenderer } from "./OverviewPage.js";

/**
 * One Overview card on its own, for a home-screen widget in the Android app
 * (app-shell's widget contract; listed by GET /api/app-widgets). The app draws
 * this page off screen at the widget's size and keeps the picture, so it must:
 * fill the window, be transparent around the card, fit the card in, and say
 * when it's done (signalWidgetReady) once nothing is still loading.
 */

/** Narrower than this, a card is laid out at this width and scaled down. */
const MIN_WIDTH = 260;
/** Shrinking the card below this drops one more part instead. */
const KEEP_SCALE = 0.85;
/** What fitting can drop, in order of preference within each kind: last first. */
const DROPPABLE = "[data-widget-optional]";
/** Then list and table rows, keeping each list's first. */
const ROWS = "li:not(:first-child), tbody > tr:not(:first-child)";

export function AppWidgetPage({ cardRef }: { cardRef: string }) {
  return (
    <ThemeProvider>
      <Fitted>
        <WidgetCard cardRef={cardRef} />
      </Fitted>
    </ThemeProvider>
  );
}

function WidgetCard({ cardRef }: { cardRef: string }) {
  const render = useCardRenderer();
  const dashboard = useDashboard();
  const card = render(cardRef);
  const fetching = useIsFetching();
  const done = (card !== null || dashboard.isError) && fetching === 0;

  useEffect(() => {
    if (!done) return;
    // Two frames: the last layout and paint (charts measure themselves) land first.
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => signalWidgetReady());
    });
    return () => cancelAnimationFrame(id);
  }, [done]);

  if (card) return <>{card}</>;
  if (dashboard.isSuccess && fetching === 0)
    return <WidgetMessage text="This card isn't in Muny any more." />;
  return null;
}

/** A short note in place of a card (signed out, removed card). Signals ready itself. */
export function WidgetMessage({ text }: { text: string }) {
  useEffect(() => {
    signalWidgetReady();
  }, []);
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div className="rounded-2xl bg-surface px-4 py-3 text-center text-sm text-slate-600 shadow dark:text-slate-300">
        {text}
      </div>
    </div>
  );
}

/**
 * Fits the card to the widget, filling it:
 * 1. Lay it out at the widget's width (text keeps its size), stretched to the height.
 * 2. While it would have to shrink below KEEP_SCALE, drop a part: first those a
 *    card marks `data-widget-optional` (detail rows, legends, charts), then
 *    list and table rows, each last first. A big widget shows the whole card;
 *    a small one the headline and top rows at nearly full size.
 * 3. If it still doesn't fit, lay it out wider until it does and scale it all
 *    down, so it fills the widget both ways instead of a narrow column.
 */
function Fitted({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);

  // Nothing behind the card: the widget shows the home screen around it.
  useLayoutEffect(() => {
    const prev = [document.documentElement.style.background, document.body.style.background];
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = prev[0] ?? "";
      document.body.style.background = prev[1] ?? "";
    };
  }, []);

  // Measured and set directly: each step needs the layout of the one before.
  // Runs again whenever the card changes size (data arriving, charts measuring).
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const fit = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // How many times too tall the card is, laid out w wide (1: it fits).
      const over = (w: number) => {
        const room = (vh * w) / vw;
        el.style.width = `${w}px`;
        el.style.minHeight = `${room}px`;
        return el.offsetHeight / room;
      };
      for (const h of el.querySelectorAll("[data-widget-hidden]"))
        h.removeAttribute("data-widget-hidden");
      let width = Math.max(vw, MIN_WIDTH);
      let ratio = over(width);
      for (const selector of [DROPPABLE, ROWS]) {
        const parts = [...el.querySelectorAll(selector)];
        while (ratio > 1 / KEEP_SCALE && parts.length > 0) {
          const part = parts.pop();
          if (!part || part.closest("[data-widget-hidden]")) continue;
          part.setAttribute("data-widget-hidden", "");
          ratio = over(width);
        }
      }
      if (ratio > 1.005) {
        // Wider until it fits: a bit wider than needed if wrapping eases, then
        // narrowed back down (a few halvings) to the snuggest fit.
        let lo = width;
        let hi = width * ratio;
        for (let i = 0; i < 4 && over(hi) > 1.005; i++) hi *= over(hi);
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          if (over(mid) > 1.005) lo = mid;
          else hi = mid;
        }
        width = hi;
        over(width);
      }
      el.style.transform = `scale(${vw / width})`;
    };
    fit();
    // The box only changes size when the card does: then it's time to fit again.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden">
      <div
        ref={inner}
        className="app-widget-fill"
        style={{ position: "absolute", top: 0, left: 0, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}
