import { useSyncExternalStore } from 'react';

/**
 * Cross-component shared "Diff selection" pool (renderer-internal state, not via IPC). DiffView writes on
 * user code selection in the Diff, ChatPane / ChatInputBar read it, to carry the selected code as **implicit
 * context** into agent/ask questions.
 *
 * Data flow:
 *   DiffView listens to Monaco onDidChangeCursorSelection → set(selection) / clear() →
 *   notify → useDiffSelection re-renders → input bar badge updates →
 *   on send (not ignored) formatReferencedContext(selection) → sent to main as referencedContext
 *
 * Same pattern as drafts-store (module-level state + Set<subscriber> + useSyncExternalStore), but purely local, no hydrate.
 */
export interface DiffSelection {
  /** PR the selection belongs to (prevents cross-PR mixups: useDiffSelection presents null when it doesn't match the current PR). */
  prLocalId: string;
  /** File path (head side uses new path, old side uses baseline path). */
  path: string;
  /** Diff sub-editor the selection is in: old=baseline(original) / new=changed(modified). */
  side: 'old' | 'new';
  /** Start/end lines (both ends inclusive, 1-based, i.e. the displayed file line numbers on that side). */
  startLine: number;
  endLine: number;
  /** Line count (endLine - startLine + 1). Refers to the head/old primary selection line count, excluding the removed lines carried below. */
  lineCount: number;
  /** Selected text snapshot (captured when the selection is produced, used directly on send, no need to re-query the model). */
  text: string;
  /**
   * Inline (unified) view only: the **baseline-side** original lines (with real code) of the deleted/changed hunk
   * spanned by the head selection. In unified view the deleted lines are Monaco view-zones and can't be cursor-selected,
   * so they are mapped via getLineChanges() and taken from the original model, referenced together with the selected
   * head lines — letting deleted content also be referenced "like added lines". May be present when side==='new' and not side-by-side view.
   */
  removed?: { startLine: number; endLine: number; text: string };
}

interface SelectionStoreState {
  selection: DiffSelection | null;
  /** Ignored state: user clicked the badge to toggle "don't carry", this message carries no selection reference (badge still shows, greyed out + eye-slash). */
  ignored: boolean;
}

let state: SelectionStoreState = { selection: null, ignored: false };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

export const selectionStore = {
  getSnapshot: (): SelectionStoreState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  /** Write a new selection. Each new selection defaults to "carry" (ignored reset to false). */
  set: (selection: DiffSelection): void => {
    state = { selection, ignored: false };
    notify();
  },
  /** Clear the selection (selection collapse / PR switch / file switch). */
  clear: (): void => {
    if (state.selection === null && !state.ignored) return;
    state = { selection: null, ignored: false };
    notify();
  },
  /** Toggle ignored state (badge click). */
  toggleIgnored: (): void => {
    if (!state.selection) return;
    state = { ...state, ignored: !state.ignored };
    notify();
  },
};

/**
 * Read the selection snapshot "belonging to the current PR". If the selection's prLocalId doesn't match the passed
 * value (switched to another PR / no PR) → returns a null selection, to avoid carrying another PR's selection into this session.
 */
export function useDiffSelection(prLocalId: string | null | undefined): {
  selection: DiffSelection | null;
  ignored: boolean;
} {
  const snap = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  if (!prLocalId || snap.selection?.prLocalId !== prLocalId) {
    return { selection: null, ignored: false };
  }
  return snap;
}

/** Line range label: single line `Lx`, multiple lines `Lx-Ly`. */
function rangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `L${String(startLine)}`
    : `L${String(startLine)}-L${String(endLine)}`;
}

/**
 * Assemble the selection into a self-describing reference block (path + line range + side + code fence); the renderer
 * assembles it once and sends it as referencedContext. Both injection paths (pragent /ask and planner) share this string.
 * Uses four-backtick fences to avoid breaking the fence when the selected code contains triple backticks.
 *
 * When the inline view carries removed, it lists two blocks: the selected head lines + the spanned baseline deleted lines,
 * so the deleted content can also be referenced.
 */
export function formatReferencedContext(sel: DiffSelection): string {
  const sideLabel = sel.side === 'old' ? 'base' : 'head';
  if (sel.removed) {
    return [
      `The user has selected a region in \`${sel.path}\` and is asking about it.`,
      '',
      `Selected lines (${rangeLabel(sel.startLine, sel.endLine)}, head side):`,
      '````',
      sel.text,
      '````',
      '',
      `Removed lines spanned by the selection (${rangeLabel(sel.removed.startLine, sel.removed.endLine)}, base side):`,
      '````',
      sel.removed.text,
      '````',
    ].join('\n');
  }
  return [
    `The user has selected these lines from \`${sel.path}\` (${rangeLabel(sel.startLine, sel.endLine)}, ${sideLabel} side) and is asking about them:`,
    '',
    '````',
    sel.text,
    '````',
  ].join('\n');
}
