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

/** Cards are laid out for a dashboard column: never narrower than this, then scaled to fit. */
const MIN_WIDTH = 340;

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

/** Lays the card out at a readable width, then scales it down to fit the window, centered. */
function Fitted({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [box, setBox] = useState({ w: 0, h: 0 });

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
    const ro = el
      ? new ResizeObserver(() => setBox({ w: el.offsetWidth, h: el.offsetHeight }))
      : null;
    if (el && ro) ro.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  const width = Math.max(view.w, MIN_WIDTH);
  const scale = box.h > 0 ? Math.min(view.w / width, view.h / box.h, 1) : view.w / width;
  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden">
      <div
        ref={inner}
        style={{ width, transform: `scale(${scale})`, transformOrigin: "center", flex: "none" }}
      >
        {children}
      </div>
    </div>
  );
}
