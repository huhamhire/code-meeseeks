// Barrel for diff business hooks: data flow (changed files / content / comments / blame / scope / navigation) and
// inline view-zone assembly (comments / drafts / hover "+" to create a draft) are each their own hook, aggregated by the DiffView composition root.
export { useFileListWidth } from './useFileListWidth';
export { useSyncProgress } from './useSyncProgress';
export { useDiffScope, type DiffScopeState } from './useDiffScope';
export { useChangedFiles, type ChangedFilesState } from './useChangedFiles';
export { useConflictFiles } from './useConflictFiles';
export { useFileContent, type FileContentState } from './useFileContent';
export { useDiffComments, type DiffCommentsState } from './useDiffComments';
export { useBlame, type BlameState } from './useBlame';
export { useDraftAutoEdit, type DraftAutoEdit } from './useDraftAutoEdit';
export { useDiffNav, type PendingNav, type PendingScroll } from './useDiffNav';
export { useCommentZones } from './useCommentZones';
export {
  useActualRenderSideBySide,
  isActualSideBySide,
} from './useActualRenderSideBySide';
export { useDiffOverviewMarks } from './useDiffOverviewMarks';
export { useDraftZones } from './useDraftZones';
export { useLineCommentAdder } from './useLineCommentAdder';
export { useSelectionCapture } from './useSelectionCapture';
