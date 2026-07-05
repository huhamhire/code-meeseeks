import { useSyncExternalStore } from 'react';
import type { EditorTheme } from '@meebox/shared';

/**
 * Renderer-layer shared state for editor appearance (Monaco color theme + monospace font). App writes it from
 * config.appearance, and deep Monaco components (DiffPane / InlineCodeContext) read it via useEditorAppearance —
 * avoiding threading props through every layer.
 *
 * Same pattern as selection-store (module-level state + Set<subscriber> + useSyncExternalStore): purely local, no IPC, no
 * hydrate. Persistence and disk writes go through config (IPC config:setEditorAppearance); this store only carries the "currently effective value".
 */
export interface EditorAppearanceState {
  /** Editor color theme preference: 'auto' follows the GUI's dark / light mode, otherwise a specific Monaco theme name. */
  editorTheme: EditorTheme;
  /** Monospace font family (empty = use the built-in mono font stack). */
  fontFamily: string;
  /** Font size (px, the baseline value before any platform fine-tuning). */
  fontSize: number;
}

let state: EditorAppearanceState = { editorTheme: 'auto', fontFamily: '', fontSize: 14 };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

const store = {
  getSnapshot: (): EditorAppearanceState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
};

/** Write the current editor appearance (App calls this when config changes). Skips if all fields are equal, avoiding pointless re-renders. */
export function setEditorAppearance(next: EditorAppearanceState): void {
  if (
    next.editorTheme === state.editorTheme &&
    next.fontFamily === state.fontFamily &&
    next.fontSize === state.fontSize
  ) {
    return;
  }
  state = next;
  notify();
}

/** Read the current editor appearance (for Monaco components). */
export function useEditorAppearance(): EditorAppearanceState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
