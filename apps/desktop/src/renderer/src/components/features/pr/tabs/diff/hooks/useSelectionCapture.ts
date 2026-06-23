import { useEffect } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import { selectionStore } from '../../../../../../stores/selection-store';

const DEBOUNCE_MS = 120;

/**
 * 捕获 Diff 里的代码选区 → 写入 selectionStore，供 ChatPane 把选中代码作为隐式上下文带进提问。
 *
 * 监听内层两个子编辑器的 onDidChangeCursorSelection（modified=新/head、original=基线/old）；选区空
 * （塌缩成光标、无文本）→ clear，否则去抖 ~120ms 后写入。Monaco diff 子编辑器的行号即该侧显示文件
 * 行号，无需 hunk 映射。文件 / PR 切换或卸载时（依赖变更触发 cleanup）一并清空，避免陈旧选区残留。
 *
 * 刻意**不**接「可评论区域」守卫（useLineCommentAdder 的 isAllowed）：行内评论受平台 anchor 约束、
 * 只能挂在 diff 命中行；而选区引用只作模型上下文、不回写远端，任意可选代码（含未改动上下文行）皆可
 * 引用——恰恰这些上下文对提问最有用，不应被评论约束挡掉。
 *
 * 统一（inline）视图下，Monaco 经典 inline diff 把删除行渲染为 modified 编辑器内的 view-zone（非任何
 * model 的文本行），original 编辑器宽度归 0 → 删除行无法被光标选中。为让删除内容也能「像添加行一样」被
 * 引用：head 选区跨到删除/改动 hunk 时，据 getLineChanges() 把对应基线行从 original model 取出，作为
 * removed 一并写入选区（见 spannedDeletions）。并排视图删除行可直接在 original 编辑器选中，故不做此增补。
 */
export function useSelectionCapture(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  selected: DiffChangedFile | null;
  prLocalId: string;
  renderSideBySide: boolean;
}): void {
  const { diffEditor, selected, prLocalId, renderSideBySide } = opts;
  useEffect(() => {
    if (!diffEditor || !selected) return;
    const modified = diffEditor.getModifiedEditor();
    const original = diffEditor.getOriginalEditor();
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 统一视图：求 head 选区 [s,e] 跨到的删除/改动 hunk 的基线侧原始行（含真实代码）。
    const spannedDeletions = (
      s: number,
      e: number,
    ): { startLine: number; endLine: number; text: string } | undefined => {
      const origModel = original.getModel();
      if (!origModel) return undefined;
      const segs: Array<{ oStart: number; oEnd: number }> = [];
      for (const c of diffEditor.getLineChanges() ?? []) {
        // 有删除/改动的基线行（纯新增 originalEndLineNumber===0 → 跳过）。
        if (c.originalStartLineNumber <= 0 || c.originalEndLineNumber <= 0) continue;
        const modStart = c.modifiedStartLineNumber;
        const modEnd = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber : c.modifiedStartLineNumber;
        // 该 hunk 在 modified 侧的落点与选区 [s,e] 有交叠 → 视为被选区跨到。
        if (modEnd < s || modStart > e) continue;
        segs.push({ oStart: c.originalStartLineNumber, oEnd: c.originalEndLineNumber });
      }
      if (segs.length === 0) return undefined;
      const oStart = Math.min(...segs.map((x) => x.oStart));
      const oEnd = Math.max(...segs.map((x) => x.oEnd));
      const text = segs
        .map((x) =>
          origModel.getValueInRange({
            startLineNumber: x.oStart,
            startColumn: 1,
            endLineNumber: x.oEnd,
            endColumn: origModel.getLineMaxColumn(x.oEnd),
          }),
        )
        .join('\n');
      return { startLine: oStart, endLine: oEnd, text };
    };

    const capture = (ed: MonacoEditor.ICodeEditor, side: 'old' | 'new'): void => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      // 空选区（光标塌缩、无选中文本）→ 清空。
      if (!sel || !model || (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)) {
        selectionStore.clear();
        return;
      }
      // 选到下一行行首（endColumn===1）时该行无实际文本，不计入行数。
      const endLine =
        sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
          ? sel.endLineNumber - 1
          : sel.endLineNumber;
      const startLine = sel.startLineNumber;
      // 统一视图 + head 选区：增补跨到的基线删除行（并排视图删除行可直接选中，不增补）。
      const removed =
        side === 'new' && !renderSideBySide ? spannedDeletions(startLine, endLine) : undefined;
      selectionStore.set({
        prLocalId,
        path: side === 'old' ? (selected.oldPath ?? selected.path) : selected.path,
        side,
        startLine,
        endLine,
        lineCount: endLine - startLine + 1,
        text: model.getValueInRange(sel),
        removed,
      });
    };

    const onChange = (ed: MonacoEditor.ICodeEditor, side: 'old' | 'new'): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => capture(ed, side), DEBOUNCE_MS);
    };

    const disposables = [
      modified.onDidChangeCursorSelection(() => onChange(modified, 'new')),
      original.onDidChangeCursorSelection(() => onChange(original, 'old')),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      for (const d of disposables) d.dispose();
      selectionStore.clear();
    };
  }, [diffEditor, selected, prLocalId, renderSideBySide]);
}
