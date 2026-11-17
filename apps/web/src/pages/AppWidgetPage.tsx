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
/** Shrinking the card below this drops one of its optional parts instead. */
const KEEP_SCALE = 0.85;

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
 * its size) and stretched to fill the height. When it's too tall, it drops the
 * parts a card marks `data-widget-optional` one at a time, last first (detail
 * rows, legends, then the chart), until it fits at nearly full size, and only
 * then scales what's left. A big widget shows the whole card; a small one the
 * headline at full size, not a tiny copy of everything.
 */
function Fitted({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [scale, setScale] = useState(1);

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

  const width = Math.max(view.w, MIN_WIDTH);
  const byWidth = view.w / width;
  // The height there is to fill, in the card's own (unscaled) pixels.
  const room = view.h / byWidth;

  // Show every part, then hide optional ones (last first) while it would
  // shrink below KEEP_SCALE. Runs again whenever the card changes size (data
  // arriving, charts measuring themselves).
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const fit = () => {
      const parts = [...el.querySelectorAll("[data-widget-optional]")];
      for (const p of parts) p.removeAttribute("data-widget-hidden");
      // minHeight is room, so the height is room unless the card needs more.
      while (el.offsetHeight > room / KEEP_SCALE && parts.length > 0)
        parts.pop()?.setAttribute("data-widget-hidden", "");
      setScale(Math.min(1, room / el.offsetHeight));
    };
    fit();
    // It only grows past room when the card needs more: then it's time to fit.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [room]);

  const shown = byWidth * scale;
  return (
    <div className="fixed inset-0 overflow-hidden">
      <div
        ref={inner}
        className="app-widget-fill"
        style={{
          width,
          minHeight: room,
          position: "absolute",
          top: 0,
          left: (view.w - width * shown) / 2,
          transform: `scale(${shown})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
