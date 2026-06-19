import { useEffect, useState } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { ReviewDraft } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { fileKey, type LoadedContent } from '../diff-types';

export interface PendingScroll {
  line: number;
  side: 'old' | 'new';
  draftId?: string;
}

export interface PendingNav {
  runId?: string;
  findingId?: string;
  anchor: { path: string; startLine: number; endLine: number };
}

/**
 * 跳转消费：来自 ChatPane → App.pendingDiffNav。设 selectedKey 切到目标文件 + 找关联草稿，
 * 再由 reveal 副作用等 selected / diffEditor / drafts 就绪后 revealLine + 短暂高亮 + autoEdit。
 * 同时把 pendingScroll 暴露给跨文件搜索跳转（DiffSearchPanel）复用。
 */
export function useDiffNav(opts: {
  files: DiffChangedFile[] | null;
  drafts: readonly ReviewDraft[] | null;
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  setSelectedKey: React.Dispatch<React.SetStateAction<string | null>>;
  pendingNav: PendingNav | null | undefined;
  onNavConsumed: (() => void) | undefined;
  triggerAutoEdit: (draftId: string) => void;
}): {
  pendingScroll: PendingScroll | null;
  setPendingScroll: React.Dispatch<React.SetStateAction<PendingScroll | null>>;
} {
  const {
    files,
    drafts,
    diffEditor,
    content,
    selected,
    setSelectedKey,
    pendingNav,
    onNavConsumed,
    triggerAutoEdit,
  } = opts;
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | null>(null);

  useEffect(() => {
    if (!pendingNav || !files) return;
    const target = files.find(
      (f) => f.path === pendingNav.anchor.path || f.oldPath === pendingNav.anchor.path,
    );
    if (target) {
      setSelectedKey(fileKey(target));
    }
    // 查现有草稿；ChatPane 端已经懒创建过了，正常情况能找到。
    // 没传 runId/findingId (PublishReviewModal anchor 点击场景) → 直接跳过查找，
    // draftId 留 undefined → 下游 effect 不会触发 autoEdit，纯 navigate
    const matchingDraft =
      pendingNav.runId && pendingNav.findingId
        ? (drafts ?? []).find(
            (d) =>
              d.source !== undefined &&
              d.source.runId === pendingNav.runId &&
              d.source.findingId === pendingNav.findingId,
          )
        : undefined;
    setPendingScroll({
      // 取 endLine 跟草稿 zone / 发布锚点对齐（见 zone 行号注释），高亮行与草稿区同位
      line: pendingNav.anchor.endLine,
      side: 'new',
      draftId: matchingDraft?.id,
    });
    onNavConsumed?.();
    // drafts 不放 dep —— nav 进来时已 ack；后续 drafts 变化不该重复触发本逻辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, files, onNavConsumed]);

  // nav 完成消费：scroll + highlight + autoEdit 关联草稿。等 selected 文件
  // 切换 + content 加载 + diffEditor 就绪 + drafts hydrated 完，再 revealLine。
  // pendingScroll 来自 nav effect (setSelectedKey 同时设的)；reveal 后清空
  useEffect(() => {
    if (!pendingScroll || !diffEditor || !content || !selected) return;
    const editor =
      pendingScroll.side === 'old'
        ? diffEditor.getOriginalEditor()
        : diffEditor.getModifiedEditor();

    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;
    const reveal = () => {
      // onDidUpdateDiff 可能多次触发，只跳一次
      if (revealed) return;
      revealed = true;
      // 居中滚到目标行
      editor.revealLineInCenter(pendingScroll.line);
      // 短暂高亮：300ms 黄底脉冲
      const collection = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: pendingScroll.line,
            startColumn: 1,
            endLineNumber: pendingScroll.line,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'monaco-draft-highlight-flash',
          },
        },
      ]);
      highlightTimer = setTimeout(() => {
        try {
          collection.clear();
        } catch {
          /* editor disposed */
        }
      }, 800);
      // 同时触发关联草稿的 autoEdit (DraftZone 自动 enter edit mode)
      if (pendingScroll.draftId) {
        triggerAutoEdit(pendingScroll.draftId);
      }
      setPendingScroll(null);
    };

    // Monaco diff 是异步算的：models 挂上(onMount)后还要等 diff 计算 +
    // hideUnchangedRegions 折叠布局完成，行号到视口位置的映射才稳定。此时
    // 直接 revealLine 会定位到旧布局/错误位置。getLineChanges() 在算完前
    // 返回 null、算完返回数组 → 已就绪直接跳，否则等 onDidUpdateDiff 首次触发。
    if (diffEditor.getLineChanges() != null) {
      reveal();
      return () => {
        if (highlightTimer) clearTimeout(highlightTimer);
      };
    }
    const disposable = diffEditor.onDidUpdateDiff(reveal);
    return () => {
      disposable.dispose();
      if (highlightTimer) clearTimeout(highlightTimer);
    };
    // triggerAutoEdit 不入 deps —— 它每次 render 换新引用，列进去会让 reveal 每帧重跑、反复定位高亮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScroll, diffEditor, content, selected]);

  return { pendingScroll, setPendingScroll };
}
