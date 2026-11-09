import type { MunyDb } from "@muny/db";

/**
 * Things other parts of Muny may want to follow up on, without the code
 * that does them knowing who's listening (bank sync doesn't import the AI).
 */

type Listener = (db: MunyDb) => void;
const added = new Set<Listener>();

/** New transactions arrived (a bank sync or an import brought some in). */
export function onTransactionsAdded(fn: Listener): () => void {
  added.add(fn);
  return () => added.delete(fn);
}

export function transactionsAdded(db: MunyDb) {
  for (const fn of added) {
    try {
      fn(db);
    } catch {
      // A listener's problem is its own.
    }
  }
}
