import { useEffect } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { ReviewDraft } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { DraftZoneList } from '../DraftZoneList';
import { mountInlineZones } from '../zones/mountInlineZones';
import type { LoadedContent } from '../diff-types';

/**
 * 内联草稿 view zones（蓝底、editable）。跟评论 zone 同套 mountInlineZones 机制，按 anchor.side
 * 分桶、用 endLine 作 zone 行号（跟发布锚点对齐，WYSIWYG）。
 *
 * 不渲染 rejected（用户决断不发）/ posted（远端评论已由 CommentZone 接管，再渲染视觉重复）。
 * commit 只读视图（scopeKind !== 'all'）不渲染草稿（锚定在 PR 全量 diff 行号上，不套用于单 commit）。
 */
export function useDraftZones(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  drafts: readonly ReviewDraft[] | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  prLocalId: string;
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  renderSideBySide: boolean;
  commentHardBreaks: boolean;
  scopeKind: 'all' | 'commit';
}): void {
  const {
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    scopeKind,
  } = opts;

  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    // commit 只读视图：不渲染本地草稿 zone（草稿锚定在 PR 全量 diff 行号上，不套用于单 commit）。
    if (scopeKind !== 'all') return;
    const fileDrafts = (drafts ?? []).filter((d) => {
      if (d.status === 'rejected' || d.status === 'posted') return false;
      return d.anchor.path === selected.path || selected.oldPath === d.anchor.path;
    });
    if (fileDrafts.length === 0) return;

    const oldByLine = new Map<number, ReviewDraft[]>();
    const newByLine = new Map<number, ReviewDraft[]>();
    for (const d of fileDrafts) {
      const target = d.anchor.side === 'old' ? oldByLine : newByLine;
      // 用 endLine 作为 zone 行号，跟发布锚点对齐 —— publishInlineComment 用 anchor.endLine 发到
      // 远端，草稿区也落 endLine 即「预览位置 = 最终发布位置」(WYSIWYG)。nav reveal 高亮行同样取
      // endLine，二者视觉一致，跨多行 finding (startLine=403, endLine=425) 也不会起止错位。
      const arr = target.get(d.anchor.endLine) ?? [];
      arr.push(d);
      target.set(d.anchor.endLine, arr);
    }

    return mountInlineZones<ReviewDraft>({
      diffEditor,
      renderSideBySide,
      oldByLine,
      newByLine,
      zoneClassName: 'monaco-draft-zone',
      innerClassName: 'monaco-draft-zone-inner',
      stopEvents: [
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'keydown',
        'keyup',
        'wheel',
        'contextmenu',
      ],
      initialHeight: (ds) => Math.max(ds.length * 60, 80),
      render: (ds) => (
        <DraftZoneList
          drafts={ds}
          prLocalId={prLocalId}
          registerEditTrigger={registerEditTrigger}
          hardBreaks={commentHardBreaks}
        />
      ),
    });
    // 不依赖 autoEditTokens / registerEditTrigger 引发的 zone 重建（registerEditTrigger 是稳定的
    // useCallback）——避免 trigger 引发 DraftZone unmount/mount，根除取消后重入 edit 模式的 race。
  }, [
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    scopeKind,
  ]);
}
