import { type editor as MonacoEditor } from 'monaco-editor';

/**
 * In the unified (inline) view the original editor is hidden and deleted lines are presented by the modified editor
 * as a view zone, so old-side comments/drafts can no longer mount on the original editor (would show "a large blank
 * with no content") and must mount on the modified editor. This maps the "original line number" to the modified
 * afterLineNumber per diff line change:
 *  - pure deletion: the deletion block falls after modifiedStartLineNumber → comment mounts after that line;
 *  - modification: align to the corresponding line within the modified block;
 *  - context lines (not inside any change): shift by the cumulative line-count difference of prior changes.
 * When the diff isn't computed yet (getLineChanges empty), falls back to the original line number + cumulative shift.
 */
export function mapOriginalLineToModified(
  changes: readonly MonacoEditor.ILineChange[],
  origLine: number,
): number {
  let delta = 0;
  for (const ch of changes) {
    const oS = ch.originalStartLineNumber;
    const oE = ch.originalEndLineNumber;
    const mS = ch.modifiedStartLineNumber;
    const mE = ch.modifiedEndLineNumber;
    if (oE === 0) {
      // Pure insertion (no line on the original side): count into the offset only when the insertion point is before origLine
      if (oS < origLine) delta += mE - mS + 1;
      continue;
    }
    if (oE < origLine) {
      // The change is entirely before origLine: accumulate the line-count difference between modified and original
      const oCount = oE - oS + 1;
      const mCount = mE === 0 ? 0 : mE - mS + 1;
      delta += mCount - oCount;
      continue;
    }
    if (oS <= origLine && origLine <= oE) {
      // origLine falls within this change
      if (mE === 0) return mS; // pure deletion: the deletion block is after modified line mS
      return Math.min(mS + (origLine - oS), mE); // modification: align to the modified block
    }
    break; // changes is ordered, the rest are all after origLine
  }
  return origLine + delta;
}

/** Remap old-side buckets to modified line numbers per diff (used in the unified view). */
export function remapOldByLineToModified<T>(
  changes: readonly MonacoEditor.ILineChange[],
  oldByLine: Map<number, T[]>,
): Map<number, T[]> {
  const remapped = new Map<number, T[]>();
  for (const [origLine, items] of oldByLine) {
    const modLine = mapOriginalLineToModified(changes, origLine);
    remapped.set(modLine, [...(remapped.get(modLine) ?? []), ...items]);
  }
  return remapped;
}
