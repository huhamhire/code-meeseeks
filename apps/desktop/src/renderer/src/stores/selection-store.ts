import { useSyncExternalStore } from 'react';

/**
 * 跨组件共享的「Diff 选区」池（渲染层内部态，不走 IPC）。DiffView 在用户于 Diff 里选中代码时写入，
 * ChatPane / ChatInputBar 读出，用于把选中代码作为**隐式上下文**带进 agent/ask 提问。
 *
 * 数据流：
 *   DiffView 监听 Monaco onDidChangeCursorSelection → set(选区) / clear() →
 *   notify → useDiffSelection 重渲染 → 输入栏角标更新 →
 *   发送时（未忽略）formatReferencedContext(选区) → 作为 referencedContext 发给 main
 *
 * 与 drafts-store 同模（模块级状态 + Set<subscriber> + useSyncExternalStore），但纯本地、无 hydrate。
 */
export interface DiffSelection {
  /** 选区归属 PR（防跨 PR 串台：useDiffSelection 不匹配当前 PR 时对外呈 null）。 */
  prLocalId: string;
  /** 文件路径（head 侧用新路径，old 侧用基线路径）。 */
  path: string;
  /** 选区所在 Diff 子编辑器：old=基线(original) / new=变更(modified)。 */
  side: 'old' | 'new';
  /** 起止行（含两端，1 基，即该侧显示文件行号）。 */
  startLine: number;
  endLine: number;
  /** 行数（endLine - startLine + 1）。指 head/old 主选区的行数，不含下方 removed 附带行。 */
  lineCount: number;
  /** 选中文本快照（选区产生时即取，发送时直接用，无需回查 model）。 */
  text: string;
  /**
   * 内联（统一）视图专属：head 选区跨到的删除/改动 hunk 的**基线侧**原始行（含真实代码）。统一视图下
   * 删除行是 Monaco view-zone、无法被光标选中，故据 getLineChanges() 映射、从 original model 取出，与
   * 所选 head 行一并引用——让删除内容也能「像添加行一样」被引用。side==='new' 且非并排视图时可能有。
   */
  removed?: { startLine: number; endLine: number; text: string };
}

interface SelectionStoreState {
  selection: DiffSelection | null;
  /** 忽略态：用户点角标切到「不附带」，本条消息不带选区引用（角标仍显示，置灰 + eye-slash）。 */
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
  /** 写入新选区。每次新选区默认「附带」（ignored 复位为 false）。 */
  set: (selection: DiffSelection): void => {
    state = { selection, ignored: false };
    notify();
  },
  /** 清空选区（选区塌缩 / 切 PR / 文件切换）。 */
  clear: (): void => {
    if (state.selection === null && !state.ignored) return;
    state = { selection: null, ignored: false };
    notify();
  },
  /** 切换忽略态（角标点击）。 */
  toggleIgnored: (): void => {
    if (!state.selection) return;
    state = { ...state, ignored: !state.ignored };
    notify();
  },
};

/**
 * 读取「归属当前 PR」的选区快照。选区 prLocalId 与传入不符（切到别的 PR / 无 PR）→ 返回 null 选区，
 * 避免把别 PR 的选区误带进本会话。
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

/** 行范围标签：单行 `Lx`，多行 `Lx-Ly`。 */
function rangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `L${String(startLine)}`
    : `L${String(startLine)}-L${String(endLine)}`;
}

/**
 * 把选区拼成自描述的引用块（路径 + 行范围 + 侧 + 代码围栏），渲染层拼一次作为 referencedContext 发出。
 * 两条注入路径（pragent /ask 与 planner）共用此串。用四个反引号围栏，避免选中代码内含三反引号时破栏。
 *
 * 内联视图带 removed 时分两块列出：所选 head 行 + 跨到的基线删除行，让删除内容也能被引用。
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
