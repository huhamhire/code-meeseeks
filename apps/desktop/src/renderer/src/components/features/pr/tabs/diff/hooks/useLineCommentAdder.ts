import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { TFunction } from 'i18next';
import type { DiffHunkRange, PlatformKind, ReviewDraft } from '@meebox/shared';
import { policyForPlatform } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';
import type { LoadedContent } from '../diff-types';

/**
 * 行 hover '+' 新建 manual 草稿：modifiedEditor (head 侧) + 并排视图下 originalEditor (base 侧)
 * 上加 mousemove + mousedown 监听。**已有评论的行仍可继续追加**（hover 照常出 +，新草稿 zone 挂在评论
 * zone 之下、按时间序在已有评论下方）；仅「已有未发布草稿」的行不重复出 +（避免同行两个编辑器）。点击 →
 * drafts:create + autoEdit 立即进入编辑。
 *
 * Platform policy 过滤：Bitbucket 只允许 hunk 内的行加 inline comment；GitHub/GitLab 宽松。从
 * diffEditor.getLineChanges() 拿 hunks，不允许的行不画 glyph、点击也不创建草稿。commit 只读视图
 * （scopeKind !== 'all'）不挂。
 */
export function useLineCommentAdder(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  drafts: readonly ReviewDraft[] | null;
  prLocalId: string;
  platform: PlatformKind;
  scopeKind: 'all' | 'commit';
  renderSideBySide: boolean;
  triggerAutoEdit: (draftId: string) => void;
  t: TFunction;
}): void {
  const {
    diffEditor,
    content,
    selected,
    drafts,
    prLocalId,
    platform,
    scopeKind,
    renderSideBySide,
    triggerAutoEdit,
    t,
  } = opts;

  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    // commit 只读视图：不挂行 hover '+' 新建草稿（草稿锚点属于 PR 全量 diff，不在单 commit 上创建）。
    if (scopeKind !== 'all') return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalEditor = diffEditor.getOriginalEditor();
    // 仅「已有未发布草稿」的行算占用、不重复出 +（避免同行两个编辑器）；已有远端评论的行不算占用——
    // 允许继续追加新评论（新草稿 zone 会挂在评论 zone 之下，按时间序展示在已有评论下方）。
    const occupiedNew = new Set<number>();
    const occupiedOld = new Set<number>();
    for (const d of drafts ?? []) {
      if (d.status === 'rejected') continue;
      // 跟 zone 创建时一致用 startLine — 之前用 endLine 会让 hover '+' 把行 403
      // (finding 起始) 当未占用错画 +；finding 跨多行场景下两个 + 同时出现
      (d.anchor.side === 'old' ? occupiedOld : occupiedNew).add(d.anchor.startLine);
    }

    // 把 monaco ILineChange[] 翻成 DiffHunkRange[]。LineChange 的 EndLineNumber=0
    // 表示该侧无对应（纯增/纯删），翻成 null range。
    //
    // **关键**：useEffect 首次执行时 monaco diff 还在异步计算，getLineChanges() 可能
    // 返回 null/[] → 用 Bitbucket policy 严格判会让"所有行都不允许" → 用户看不到任何 +。
    // 监听 onDidUpdateDiff 在 diff 算完后刷新 hunks (mutable let，闭包引用最新值)。
    // 同时：hunks 为空时**兜底允许**（视为 policy 暂不可用），等 update 事件来再收紧
    const policy = policyForPlatform(platform);
    const computeHunks = (): DiffHunkRange[] => {
      const lineChanges = diffEditor.getLineChanges() ?? [];
      return lineChanges.map((c) => ({
        original:
          c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0
            ? { start: c.originalStartLineNumber, end: c.originalEndLineNumber }
            : null,
        modified:
          c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0
            ? { start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber }
            : null,
      }));
    };
    let hunks = computeHunks();
    const diffUpdateDisp = diffEditor.onDidUpdateDiff(() => {
      hunks = computeHunks();
    });

    const disposers: Array<() => void> = [];

    // 在指定编辑器 + 侧别上挂「hover 出 + / 点击建草稿」。modified=new（新增/上下文行），
    // original=old（删除/上下文行，仅并排视图可点 —— 统一视图下原始编辑器隐藏、删除行是 view zone 无行号可 hover）。
    const wireAdder = (
      editorInst: MonacoEditor.ICodeEditor,
      side: 'old' | 'new',
      occupied: Set<number>,
    ): void => {
      /** 兜底允许：hunks 还没算完（空数组）就一律允许，避免初始"什么都点不出来"。
       *  正常加载完 hunks 非空后才走 policy 严格判 */
      const isAllowed = (line: number): boolean =>
        hunks.length === 0 || policy.isLineAllowed(hunks, side, line);

      let hoverLine: number | null = null;
      const collection = editorInst.createDecorationsCollection([]);

      const setHover = (line: number | null): void => {
        hoverLine = line;
        collection.set(
          line === null || occupied.has(line) || !isAllowed(line)
            ? []
            : [
                {
                  range: {
                    startLineNumber: line,
                    startColumn: 1,
                    endLineNumber: line,
                    endColumn: 1,
                  },
                  options: {
                    isWholeLine: false,
                    // 用 glyphMarginClassName 跟 commentZone (远端评论) 一致 —— 渲染在
                    // editor 最左 glyph margin 列 (跟 GitHub 评论 "+" 位置惯例一致)。
                    glyphMarginClassName: 'monaco-draft-add-glyph',
                    glyphMarginHoverMessage: { value: t('diffView.addCommentHint') },
                  },
                },
              ],
        );
      };

      const onMove = editorInst.onMouseMove((e) => {
        const tgt = e.target;
        if (
          (tgt.type === MonacoEditorNs.MouseTargetType.GUTTER_GLYPH_MARGIN ||
            tgt.type === MonacoEditorNs.MouseTargetType.GUTTER_LINE_NUMBERS) &&
          tgt.position
        ) {
          const ln = tgt.position.lineNumber;
          if (hoverLine !== ln) setHover(ln);
        } else if (hoverLine !== null) {
          setHover(null);
        }
      });

      const onLeave = editorInst.onMouseLeave(() => {
        if (hoverLine !== null) setHover(null);
      });

      const onDown = editorInst.onMouseDown((e) => {
        const tgt = e.target;
        if (
          tgt.type === MonacoEditorNs.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          tgt.position &&
          !occupied.has(tgt.position.lineNumber) &&
          isAllowed(tgt.position.lineNumber)
        ) {
          const line = tgt.position.lineNumber;
          void (async () => {
            try {
              const created = await invoke('drafts:create', {
                localId: prLocalId,
                draft: {
                  anchor: { path: selected.path, startLine: line, endLine: line, side },
                  body: '',
                  origin: 'manual',
                  status: 'pending',
                },
              });
              // 新建后立即触发 auto edit，让用户能马上输入
              triggerAutoEdit(created.id);
            } catch {
              // 静默；UI 上没出 zone 就视为没创建成功
            }
          })();
        }
      });

      disposers.push(() => {
        onMove.dispose();
        onLeave.dispose();
        onDown.dispose();
        try {
          collection.clear();
        } catch {
          /* editor disposed */
        }
      });
    };

    // 新增 / 上下文行（head 侧）始终可点；删除 / 上下文行（base 侧）仅并排视图可点
    // （统一视图原始编辑器隐藏，删除行以 view zone 呈现、无可 hover 的行号）。
    wireAdder(modifiedEditor, 'new', occupiedNew);
    if (renderSideBySide) {
      wireAdder(originalEditor, 'old', occupiedOld);
    }

    return () => {
      diffUpdateDisp.dispose();
      for (const dispose of disposers) dispose();
    };
    // triggerAutoEdit 不入 deps —— 它每次 render 换新引用，列进去会让本 effect 每帧重挂监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    diffEditor,
    content,
    selected,
    drafts,
    prLocalId,
    platform,
    t,
    scopeKind,
    renderSideBySide,
  ]);
}
