import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffBlameLine } from '@meebox/ipc';
import { Avatar } from '../../../../../common';
import {
  BLAME_COLUMN_WIDTH,
  formatIsoDate,
  groupBlameByCommit,
  mergeContiguousLines,
  type BlameBlock,
  type BlameLayout,
} from './blame-utils';

/**
 * Bitbucket 风格 blame 列。独立于 Monaco DOM 之外，作为 diff-pane-wrapper 的左侧
 * flex 子项；内部用 absolute 子项画各 commit 区块，按 Monaco scrollTop 平移。
 *
 * 设计权衡：
 * - 不走 Monaco InjectedText (DiffEditor 里实测不渲染，详见 commit 提交记录)
 * - 不走 Monaco overlay widget (没有"绝对行号"定位选项，只能贴角)
 * - 独立 DOM 列：可控、稳定、跟 React 生命周期一致；唯一成本是要同步 scrollTop
 */
export function BlameColumn({
  blame,
  layout,
  connectionId,
  diffEditor,
}: {
  blame: { lines: DiffBlameLine[]; changedLines: number[] };
  layout: BlameLayout;
  connectionId: string;
  diffEditor: MonacoEditor.IStandaloneDiffEditor;
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => groupBlameByCommit(blame.lines), [blame.lines]);
  // 把 changedLines 合并成连续区段，渲染色带（减少 DOM 数量）
  const changedRanges = useMemo(
    () => mergeContiguousLines(blame.changedLines),
    [blame.changedLines],
  );
  const modifiedEditor = diffEditor.getModifiedEditor();
  // layout 只是触发器：scrollTop / viewportHeight 任一变就重渲，重渲时再走 Monaco
  // 实时坐标 API，避免行数学手算和 Monaco 实际渲染的偏差（padding / view zones /
  // hideUnchangedRegions 占位 / sticky scroll 全靠 Monaco 自己算）
  // 注意：layout 也被上面 style 的 --blame-lh 引用

  // 只渲染 Monaco 当前可见的行：hideUnchangedRegions 折叠掉的行返回的 range
  // 里不会出现，自然不画 blame；评论 view zone 撑出的额外高度也由 Monaco 的
  // getTopForLineNumber 反映
  const visibleRanges = modifiedEditor.getVisibleRanges();
  const scrollTop = modifiedEditor.getScrollTop();

  type BlameItem = {
    kind: 'blame';
    block: BlameBlock;
    top: number;
    height: number;
    segId: string;
  };
  type ChangeItem = {
    kind: 'change';
    top: number;
    height: number;
    segId: string;
  };
  type FoldItem = { kind: 'fold'; top: number; height: number; segId: string };
  type Item = BlameItem | ChangeItem | FoldItem;
  const items: Item[] = [];

  // 1) Blame 区块：跟 visible range 求交集
  for (const range of visibleRanges) {
    for (const block of blocks) {
      const from = Math.max(block.lineFrom, range.startLineNumber);
      const to = Math.min(block.lineTo, range.endLineNumber);
      if (from > to) continue;
      const yTop = modifiedEditor.getTopForLineNumber(from) - scrollTop;
      const yBottom = modifiedEditor.getTopForLineNumber(to + 1) - scrollTop;
      items.push({
        kind: 'blame',
        block,
        top: yTop,
        height: Math.max(1, yBottom - yTop),
        segId: `b-${block.commit}-${String(from)}-${String(to)}`,
      });
    }
  }

  // 2) PR 改动行色带：在可见 range 内的部分画绿色竖条占位（不带文字，跟 Monaco
  //    diff 的"added"装饰呼应）
  for (const range of visibleRanges) {
    for (const [from0, to0] of changedRanges) {
      const from = Math.max(from0, range.startLineNumber);
      const to = Math.min(to0, range.endLineNumber);
      if (from > to) continue;
      const yTop = modifiedEditor.getTopForLineNumber(from) - scrollTop;
      const yBottom = modifiedEditor.getTopForLineNumber(to + 1) - scrollTop;
      items.push({
        kind: 'change',
        top: yTop,
        height: Math.max(1, yBottom - yTop),
        segId: `c-${String(from)}-${String(to)}`,
      });
    }
  }

  // 3) 折叠占位行（"X hidden lines"）：相邻两个 visibleRange 之间一行的位置，
  //    用斜纹/灰底标识"无效行"——这一行不对应 head 文件里任何 line，blame
  //    自然没有。
  for (let i = 0; i < visibleRanges.length - 1; i++) {
    const cur = visibleRanges[i]!;
    const next = visibleRanges[i + 1]!;
    if (next.startLineNumber - cur.endLineNumber <= 1) continue;
    // 占位行在 cur 的最后一行底部与 next 第一行顶部之间
    const yTop = modifiedEditor.getTopForLineNumber(cur.endLineNumber + 1) - scrollTop;
    const yBottom = modifiedEditor.getTopForLineNumber(next.startLineNumber) - scrollTop;
    if (yBottom <= yTop) continue;
    items.push({
      kind: 'fold',
      top: yTop,
      height: yBottom - yTop,
      segId: `f-${String(cur.endLineNumber)}-${String(next.startLineNumber)}`,
    });
  }

  return (
    <aside
      className="blame-column"
      // --blame-lh = Monaco 的实际行高，让 blame-row 的 grid 行轨道 / line-height
      // 都用同一个值，垂直跟 Monaco 第一行代码同高、同 baseline
      style={
        {
          width: BLAME_COLUMN_WIDTH,
          '--blame-lh': `${String(layout.lineHeight)}px`,
        } as React.CSSProperties
      }
      aria-label="blame"
    >
      <div className="blame-column-inner">
        {items.map((it) => {
          if (it.kind === 'blame') {
            return (
              <BlameRow
                key={it.segId}
                block={it.block}
                top={it.top}
                height={it.height}
                connectionId={connectionId}
              />
            );
          }
          if (it.kind === 'change') {
            return (
              <div
                key={it.segId}
                className="blame-row-change"
                style={{ top: it.top, height: it.height }}
                title={t('diffView.blameChangeRangeTitle')}
                aria-hidden="true"
              />
            );
          }
          // fold placeholder
          return (
            <div
              key={it.segId}
              className="blame-row-fold"
              style={{ top: it.top, height: it.height }}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </aside>
  );
}

function BlameRow({
  block,
  top,
  height,
  connectionId,
}: {
  block: BlameBlock;
  top: number;
  height: number;
  connectionId: string;
}) {
  // 用 ISO 风格 YYYY-MM-DD：locale 无关、固定 10 字符，在 70px 列宽稳定显示。
  // toLocaleDateString 的中文输出 "2023年3月29日" 太宽会被截断。
  const dateStr = block.authorDate ? formatIsoDate(new Date(block.authorDate)) : '';
  const title = `${block.author}\n${block.commit.slice(0, 12)}\n${block.summary}\n${
    block.authorDate ? new Date(block.authorDate).toLocaleString() : ''
  }`;
  return (
    <div className="blame-row" style={{ top, height }} title={title}>
      <Avatar
        connectionId={connectionId}
        slug={block.author}
        displayName={block.author}
        size={18}
      />
      <span className="blame-row-name" title={block.author}>
        {block.author}
      </span>
      <span className="blame-row-sha">{block.commit.slice(0, 11)}</span>
      <span className="blame-row-date">{dateStr}</span>
    </div>
  );
}
