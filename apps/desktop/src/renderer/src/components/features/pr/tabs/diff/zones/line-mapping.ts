import { type editor as MonacoEditor } from 'monaco-editor';

/**
 * 统一(inline)视图下原始编辑器隐藏、删除行由 modified 编辑器以 view zone 呈现，故 old 侧评论/草稿
 * 不能再挂原始编辑器（会出现「大段空白、无内容」），须改挂 modified 编辑器。这里按 diff 行变更把
 * 「原始行号」映射成 modified 的 afterLineNumber：
 *  - 纯删除：删除块落在 modifiedStartLineNumber 之后 → 评论挂该行后；
 *  - 修改：对齐到 modified 块内对应行；
 *  - 上下文行（不在任何变更内）：按之前各变更的累计行数差平移。
 * diff 尚未计算（getLineChanges 为空）时退化为原行号 + 累计平移。
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
      // 纯插入（原始侧无行）：仅当插入点在 origLine 之前才计入偏移
      if (oS < origLine) delta += mE - mS + 1;
      continue;
    }
    if (oE < origLine) {
      // 变更整体在 origLine 之前：累计 modified 与 original 的行数差
      const oCount = oE - oS + 1;
      const mCount = mE === 0 ? 0 : mE - mS + 1;
      delta += mCount - oCount;
      continue;
    }
    if (oS <= origLine && origLine <= oE) {
      // origLine 落在本变更内
      if (mE === 0) return mS; // 纯删除：删除块在 modified 行 mS 之后
      return Math.min(mS + (origLine - oS), mE); // 修改：对齐 modified 块
    }
    break; // changes 有序，后续都在 origLine 之后
  }
  return origLine + delta;
}

/** 把 old 侧分桶按 diff 重映射到 modified 行号（统一视图用）。 */
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
