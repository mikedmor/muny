import { useIsFetching } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
/** Scaling below this first drops the card's optional parts. */
const COMPACT_BELOW = 0.8;

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
 * Fits the card to the widget: laid out at the widget's own width (text keeps
 * its size), stretched to fill the height, and only scaled down when it still
 * doesn't fit. Before scaling far, it drops the parts a card marks
 * `data-widget-optional` (charts, detail rows), so a small widget shows the
 * headline at full size instead of a tiny copy of the whole card.
 */
function Fitted({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [height, setHeight] = useState(0);
  const [compact, setCompact] = useState(false);

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

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    const el = inner.current;
    const ro = el ? new ResizeObserver(() => setHeight(el.offsetHeight)) : null;
    if (el && ro) ro.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  const width = Math.max(view.w, MIN_WIDTH);
  const byWidth = view.w / width;
  // The height there is to fill, in the card's own (unscaled) pixels.
  const room = view.h / byWidth;
  const byHeight = height > room ? room / height : 1;

  // Too tall to show well: drop the optional parts first (once), then measure again.
  useLayoutEffect(() => {
    if (
      !compact &&
      byHeight < COMPACT_BELOW &&
      inner.current?.querySelector("[data-widget-optional]")
    )
      setCompact(true);
  }, [compact, byHeight]);

  const scale = byWidth * byHeight;
  return (
    <div className="fixed inset-0 overflow-hidden" data-widget-compact={compact ? "" : undefined}>
      <div
        ref={inner}
        className="app-widget-fill"
        style={{
          width,
          minHeight: room,
          position: "absolute",
          top: 0,
          left: (view.w - width * scale) / 2,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
