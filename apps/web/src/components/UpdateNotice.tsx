import { useMeta } from "../lib/auth.js";

/** The version this page was built as (undefined in tests). */
const built = typeof __MUNY_UI_VERSION__ === "string" ? __MUNY_UI_VERSION__ : null;

/** Muny was updated while this tab was open: offer to load the new version. */
export function UpdateNotice() {
  const meta = useMeta();
  const now = meta.data?.version;
  if (!built || !now || now === built) return null;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:bg-brand-700/20 dark:text-brand-200">
      Muny was updated to v{now}.
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="font-medium underline"
      >
        Reload to use it
      </button>
    </p>
  );
}
