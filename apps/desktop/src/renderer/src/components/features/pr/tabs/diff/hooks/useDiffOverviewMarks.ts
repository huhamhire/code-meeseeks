import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import type { LoadedContent } from '../diff-types';

// 增/改绿、删红（与 GitHub diff 配色同系）。diff 标记走 overview ruler 的 Left 道，
// 跟评论锚点（Right 道，见 useCommentZones）分列，互不遮挡。
const ADDED_COLOR = '#3fb950';
const REMOVED_COLOR = '#f85149';

/**
 * 把 diff 增/删/改投影到内层编辑器自带的 overview ruler（编辑模式风格，单条滚动条标尺），
 * 替代 diff 专属的 renderOverviewRuler 宽列（那条在并排视图会多出独立列，见 DiffPane）。
 *
 * - modified 编辑器：增 / 改行绿色；纯删在删除点打一条红 tick
 * - 并排视图下 original 编辑器：删 / 改行红色
 *
 * diff 异步算完后 getLineChanges() 才有值；首帧已算完直接刷，否则等 onDidUpdateDiff。
 */
export function useDiffOverviewMarks(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  renderSideBySide: boolean;
}): void {
  const { diffEditor, content, selected, renderSideBySide } = opts;
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalEditor = diffEditor.getOriginalEditor();
    const modCol = modifiedEditor.createDecorationsCollection([]);
    const origCol = originalEditor.createDecorationsCollection([]);

    const Lane = MonacoEditorNs.OverviewRulerLane;
    const deco = (
      startLine: number,
      endLine: number,
      color: string,
      position: number,
    ): MonacoEditor.IModelDeltaDecoration => ({
      range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
      options: { overviewRuler: { color, position } },
    });

    const refresh = (): void => {
      const changes = diffEditor.getLineChanges() ?? [];
      const modDecos: MonacoEditor.IModelDeltaDecoration[] = [];
      const origDecos: MonacoEditor.IModelDeltaDecoration[] = [];
      for (const c of changes) {
        const isInsert = c.originalEndLineNumber === 0; // 纯增（原始侧无行）
        const isDelete = c.modifiedEndLineNumber === 0; // 纯删（修改侧无行）
        // 增 / 改：modified 侧 modifiedStart..End 标绿（左道）
        if (!isDelete) {
          modDecos.push(
            deco(c.modifiedStartLineNumber, c.modifiedEndLineNumber, ADDED_COLOR, Lane.Left),
          );
        }
        // 删 / 改的「移除部分」标红：
        if (!isInsert) {
          if (renderSideBySide) {
            // 并排：红画在左侧 original 编辑器自带 ruler（左道），与右侧绿互不干扰
            origDecos.push(
              deco(c.originalStartLineNumber, c.originalEndLineNumber, REMOVED_COLOR, Lane.Left),
            );
          } else {
            // 统一视图：original 编辑器不可见，红 tick 与绿同画在左道（同一条 diff 泳道）。
            // 被删行在 unified 下是 view zone（无 model 行号），只能标在删除点 modifiedStartLineNumber；
            // 改块同一行既绿又红时绿覆盖红 → 改块呈绿、纯删那行（无绿）呈红。
            const line = Math.max(1, c.modifiedStartLineNumber);
            modDecos.push(deco(line, line, REMOVED_COLOR, Lane.Left));
          }
        }
      }
      modCol.set(modDecos);
      origCol.set(origDecos);
    };

    if (diffEditor.getLineChanges() != null) refresh();
    const disp = diffEditor.onDidUpdateDiff(refresh);
    return () => {
      disp.dispose();
      try {
        modCol.clear();
        origCol.clear();
      } catch {
        /* editor disposed */
      }
    };
  }, [diffEditor, content, selected, renderSideBySide]);
}
