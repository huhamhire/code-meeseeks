import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffBlameLine } from '@meebox/ipc';
import { Avatar } from '../../../../../common';
import { formatTimestamp } from '../../../../../../utils/time';
import {
  BLAME_COLUMN_WIDTH,
  formatIsoDate,
  groupBlameByCommit,
  mergeContiguousLines,
  type BlameBlock,
  type BlameLayout,
} from './blame-utils';

/**
 * Bitbucket-style blame column. Lives outside the Monaco DOM, as the left flex
 * child of diff-pane-wrapper; internally draws each commit block with absolute
 * children, shifted by Monaco scrollTop.
 *
 * Design trade-offs:
 * - Not using Monaco InjectedText (verified not rendered inside DiffEditor, see commit history)
 * - Not using Monaco overlay widget (no "absolute line number" positioning option, can only pin to corners)
 * - Independent DOM column: controllable, stable, in sync with the React lifecycle; the only cost is syncing scrollTop
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
  // Merge changedLines into contiguous ranges to render color bands (reduces DOM count)
  const changedRanges = useMemo(
    () => mergeContiguousLines(blame.changedLines),
    [blame.changedLines],
  );
  const modifiedEditor = diffEditor.getModifiedEditor();
  // layout is only a trigger: any change to scrollTop / viewportHeight re-renders, and on re-render
  // we go through Monaco's live coordinate API, avoiding manual line math and its divergence from
  // Monaco's actual rendering (padding / view zones / hideUnchangedRegions placeholders / sticky
  // scroll are all computed by Monaco itself)
  // Note: layout is also referenced by --blame-lh in the style above

  // Only render lines currently visible in Monaco: lines folded away by hideUnchangedRegions
  // won't appear in the returned range, so no blame is drawn for them; the extra height pushed
  // out by comment view zones is also reflected by Monaco's getTopForLineNumber
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

  // 1) Blame blocks: intersect with visible range
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

  // 2) PR changed-line color band: draw a green vertical bar placeholder for the part within the
  //    visible range (no text, echoing Monaco diff's "added" decoration)
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

  // 3) Fold placeholder line ("X hidden lines"): the position of the one line between two adjacent
  //    visibleRanges, marked with hatching/gray background as an "invalid line"—this line does not
  //    correspond to any line in the head file, so naturally has no blame.
  for (let i = 0; i < visibleRanges.length - 1; i++) {
    const cur = visibleRanges[i]!;
    const next = visibleRanges[i + 1]!;
    if (next.startLineNumber - cur.endLineNumber <= 1) continue;
    // The placeholder line sits between the bottom of cur's last line and the top of next's first line
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
      // --blame-lh = Monaco's actual line height, so blame-row's grid row track / line-height
      // both use the same value, vertically matching Monaco's first code line in height and baseline
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
  // Use ISO-style YYYY-MM-DD: locale-independent, fixed 10 characters, displays stably in the 70px column width.
  // toLocaleDateString's Chinese output "2023年3月29日" is too wide and would be truncated.
  const dateStr = block.authorDate ? formatIsoDate(new Date(block.authorDate)) : '';
  const title = `${block.author}\n${block.commit.slice(0, 12)}\n${block.summary}\n${
    block.authorDate ? formatTimestamp(block.authorDate, { full: true }) : ''
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
