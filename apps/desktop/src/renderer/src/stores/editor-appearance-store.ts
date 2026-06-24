import { useSyncExternalStore } from 'react';
import type { EditorTheme } from '@meebox/shared';

/**
 * 编辑器外观（Monaco 配色主题 + 等宽字体）的渲染层共享态。App 从 config.appearance 写入，深层的 Monaco
 * 组件（DiffPane / InlineCodeContext）经 useEditorAppearance 读出 —— 避免逐层透传 props。
 *
 * 与 selection-store 同模（模块级状态 + Set<subscriber> + useSyncExternalStore）：纯本地、无 IPC、无
 * hydrate。持久化与写盘走 config（IPC config:setEditorAppearance），本 store 只承载「当前生效值」。
 */
export interface EditorAppearanceState {
  /** 编辑器配色主题偏好：'auto' 跟随 GUI 深 / 浅色，其余为具体 Monaco 主题名。 */
  editorTheme: EditorTheme;
  /** 等宽字体族（空 = 用内置 mono 字体栈）。 */
  fontFamily: string;
}

let state: EditorAppearanceState = { editorTheme: 'auto', fontFamily: '' };
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

/** 写入当前编辑器外观（App 在 config 变化时调用）。引用相等则跳过，避免无谓重渲。 */
export function setEditorAppearance(next: EditorAppearanceState): void {
  if (next.editorTheme === state.editorTheme && next.fontFamily === state.fontFamily) return;
  state = next;
  notify();
}

/** 读当前编辑器外观（Monaco 组件用）。 */
export function useEditorAppearance(): EditorAppearanceState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
