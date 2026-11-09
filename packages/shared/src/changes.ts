/** Undo: the history of changes, and what undoing one would do. */

export interface ChangeItem {
  id: string;
  /** unix ms */
  at: number;
  actor: { type: "user" | "agent" | "system"; name: string | null };
  /** "Changed transaction “Corner Cafe”", "Approved “Put 3 transactions in Coffee”" */
  title: string;
  /** What it touched: "2 transactions changed", "1 rule added". */
  parts: string[];
  /** Undone (and not redone since). */
  undone: boolean;
  /** This change was itself an undo, of that change. */
  undoOf: string | null;
}

export interface ChangeList {
  items: ChangeItem[];
  /** Pass as `before` for older ones; null at the end. */
  next: number | null;
}

export interface UndoPreview {
  title: string;
  /** What undoing would do: "1 rule removed", "2 transactions changed back". */
  effects: string[];
  /** Things changed since, which undoing would overwrite: "Transaction “Corner Cafe” was changed afterwards". */
  conflicts: string[];
  /** How many conflicts in all (only the first few are listed). */
  conflictCount: number;
  /** Undoing also changes things that weren't part of the change (like transactions in an account it removes). */
  extra: boolean;
  /** Why it can't be undone, if it can't. */
  error: string | null;
}

export interface UndoResult {
  /** The undo, itself a change (undo it to redo). */
  id: string;
  title: string;
}

/** The header naming the change a request made, when it made one worth offering to undo. */
export const CHANGE_HEADER = "x-muny-change";
export const CHANGE_TITLE_HEADER = "x-muny-change-title";
