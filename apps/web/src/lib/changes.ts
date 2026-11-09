import type { UndoPreview, UndoResult } from "@muny/shared";
import { ApiError, api } from "./api.js";

/**
 * The changes this tab made, as the server names them (it says so in a header
 * on each response), so the page can offer to undo the latest one.
 */

export interface MadeChange {
  id: string;
  title: string;
  /** This one is an undo: offer Redo rather than Undo. */
  isUndo?: boolean;
}

type Listener = (c: MadeChange) => void;
const listeners = new Set<Listener>();
let latest: MadeChange | null = null;

export function announceChange(c: MadeChange) {
  latest = c;
  for (const l of listeners) l(c);
}

export function onChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const latestChange = () => latest;

export type UndoOutcome =
  | { done: true; result: UndoResult }
  | { done: false; preview: UndoPreview }
  | { done: false; error: string };

/** Undo a change. Comes back with the preview instead when it needs a look first. */
export async function undo(id: string, force = false): Promise<UndoOutcome> {
  try {
    const result = await api.post<UndoResult>(`/api/changes/${id}/undo`, { force });
    return { done: true, result };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body.details)
      return { done: false, preview: e.body.details as UndoPreview };
    return { done: false, error: e instanceof Error ? e.message : "That couldn't be undone." };
  }
}
