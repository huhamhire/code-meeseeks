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
 */
export function useSelectionCapture(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  selected: DiffChangedFile | null;
  prLocalId: string;
}): void {
  const { diffEditor, selected, prLocalId } = opts;
  useEffect(() => {
    if (!diffEditor || !selected) return;
    const modified = diffEditor.getModifiedEditor();
    const original = diffEditor.getOriginalEditor();
    let timer: ReturnType<typeof setTimeout> | null = null;

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
      selectionStore.set({
        prLocalId,
        path: side === 'old' ? (selected.oldPath ?? selected.path) : selected.path,
        side,
        startLine,
        endLine,
        lineCount: endLine - startLine + 1,
        text: model.getValueInRange(sel),
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
  }, [diffEditor, selected, prLocalId]);
}
