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
 * 注意：`renderSideBySide` 是用户在工具栏选的「并排 / 统一」**意向**，而 Monaco 在宽度不足时会
 * 自动把并排降级成 inline/unified 布局（useInlineViewWhenSpaceIsLimited 默认开），此时意向仍为
 * 并排但实际渲染是统一。若按意向把删除红标画到 original 编辑器，降级后 original 不可见 → 红标全丢、
 * 滚动条只剩绿色。故按 **实际渲染模式** 决定红标去向：Monaco 把实际模式反映在 `.monaco-diff-editor`
 * 根节点的 `side-by-side` class 上（降级 inline 时去掉），据此判定，而非用户意向 prop。
 *
 * diff 异步算完后 getLineChanges() 才有值；首帧已算完直接刷，否则等 onDidUpdateDiff。布局在断点处
 * 切换并排 ↔ 统一时（onDidLayoutChange）按新模式重画红标（rAF 合并、待 class 切换稳定后再读）。
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

    // 实际是否并排：读 Monaco 反映实际渲染模式的 `.monaco-diff-editor.side-by-side` class
    // （宽度不足自动降级 inline 时去掉该 class）；取不到时回退用户意向 prop。
    const isSideBySide = (): boolean => {
      if (!renderSideBySide) return false;
      const el = diffEditor.getContainerDomNode().querySelector('.monaco-diff-editor');
      return el ? el.classList.contains('side-by-side') : true;
    };

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
      const sideBySide = isSideBySide();
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
          if (sideBySide) {
            // 并排：红画在左侧 original 编辑器自带 ruler（左道），与右侧绿互不干扰
            origDecos.push(
              deco(c.originalStartLineNumber, c.originalEndLineNumber, REMOVED_COLOR, Lane.Left),
            );
          } else {
            // 统一视图（含并排降级而来）：original 编辑器不可见，红 tick 与绿同画在 modified 左道。
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
    // 宽度跨断点导致并排 ↔ 统一切换时，红标去向随之改变 → 重画。layout 事件可能早于 Monaco 切
    // `side-by-side` class，故用 rAF 推迟到本帧末再读 class；rAF 同时合并 resize 期间的高频事件。
    let raf = 0;
    const scheduleRefresh = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        refresh();
      });
    };
    const layoutDisp = originalEditor.onDidLayoutChange(scheduleRefresh);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      disp.dispose();
      layoutDisp.dispose();
      try {
        modCol.clear();
        origCol.clear();
      } catch {
        /* editor disposed */
      }
    };
  }, [diffEditor, content, selected, renderSideBySide]);
}
