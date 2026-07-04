import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { TFunction } from 'i18next';
import type { DiffHunkRange, PlatformKind, ReviewDraft } from '@meebox/shared';
import { policyForPlatform } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';
import type { LoadedContent } from '../diff-types';

/**
 * Line hover '+' to create a manual draft: attaches mousemove + mousedown listeners on modifiedEditor (head side)
 * and, in side-by-side view, originalEditor (base side). **Lines that already have comments can still be appended to** (hover still shows +, the new draft zone mounts below the comment
 * zone, in time order beneath existing comments); only lines that "already have an unpublished draft" do not show + again (to avoid two editors on the same line). Click →
 * drafts:create + autoEdit immediately enters edit.
 *
 * Platform policy filter: Bitbucket only allows lines inside a hunk to have an inline comment; GitHub/GitLab are lenient. Gets
 * hunks from diffEditor.getLineChanges(); disallowed lines get no glyph, and clicking creates no draft. The commit read-only view
 * (scopeKind !== 'all') is not wired.
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
  /** Content read-only (declined / non-participable archived PR): does not wire line hover '+' to create comment drafts. */
  readOnly?: boolean;
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
    readOnly = false,
    triggerAutoEdit,
    t,
  } = opts;

  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    // commit read-only view: does not wire line hover '+' to create drafts (draft anchors belong to the PR full diff, not created on a single commit).
    // Content read-only (declined / non-participable archived PR): likewise does not wire '+'.
    if (scopeKind !== 'all' || readOnly) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalEditor = diffEditor.getOriginalEditor();
    // Only lines that "already have an unpublished draft" count as occupied and do not show + again (to avoid two editors on the same line); lines with existing remote comments do not count as occupied —
    // allowing new comments to be appended (the new draft zone mounts below the comment zone, shown in time order beneath existing comments).
    const occupiedNew = new Set<number>();
    const occupiedOld = new Set<number>();
    for (const d of drafts ?? []) {
      if (d.status === 'rejected') continue;
      // Use startLine consistently with zone creation — previously using endLine would make hover '+' treat line 403
      // (finding start) as unoccupied and wrongly draw +; in a multi-line finding scenario two + would appear at once
      (d.anchor.side === 'old' ? occupiedOld : occupiedNew).add(d.anchor.startLine);
    }

    // Translate monaco ILineChange[] into DiffHunkRange[]. A LineChange EndLineNumber=0
    // means that side has no counterpart (pure add / pure delete), translated into a null range.
    //
    // **Key**: on the first useEffect run, the monaco diff is still computing asynchronously, and getLineChanges() may
    // return null/[] → a strict Bitbucket policy check would make "all lines disallowed" → the user sees no + at all.
    // Listen to onDidUpdateDiff to refresh hunks after the diff finishes (mutable let, closure references the latest value).
    // Meanwhile: when hunks is empty, **fall back to allowing** (treated as policy temporarily unavailable), tightening once the update event arrives
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

    // Wire "hover shows + / click creates draft" on a given editor + side. modified=new (added/context lines),
    // original=old (deleted/context lines, clickable only in side-by-side view — in unified view the original editor is hidden, and deleted lines are view zones with no line number to hover).
    const wireAdder = (
      editorInst: MonacoEditor.ICodeEditor,
      side: 'old' | 'new',
      occupied: Set<number>,
    ): void => {
      /** Fallback allow: while hunks are not yet computed (empty array), allow everything, avoiding the initial "nothing is clickable".
       *  Only after normal loading, when hunks is non-empty, does it run the strict policy check */
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
                    // Use glyphMarginClassName consistent with commentZone (remote comments) — rendered in
                    // the editor's leftmost glyph margin column (matching the GitHub comment "+" position convention).
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
              // Trigger auto edit immediately after creation, so the user can type right away
              triggerAutoEdit(created.id);
            } catch {
              // Silent; if no zone appears in the UI, treat it as a failed creation
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

    // Added / context lines (head side) are always clickable; deleted / context lines (base side) are clickable only in side-by-side view
    // (in unified view the original editor is hidden, and deleted lines are presented as view zones with no hoverable line number).
    wireAdder(modifiedEditor, 'new', occupiedNew);
    if (renderSideBySide) {
      wireAdder(originalEditor, 'old', occupiedOld);
    }

    return () => {
      diffUpdateDisp.dispose();
      for (const dispose of disposers) dispose();
    };
    // triggerAutoEdit is not in deps — it changes reference every render, so listing it would make this effect re-attach listeners every frame
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
    readOnly,
  ]);
}
