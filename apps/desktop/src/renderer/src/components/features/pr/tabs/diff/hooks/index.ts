// diff 业务 hooks 的 barrel：数据流（变更文件 / 内容 / 评论 / blame / 范围 / 跳转）与
// 行内 view-zone 装配（评论 / 草稿 / hover「+」新建草稿）各自成 hook，由 DiffView 组合根聚合。
export { useFileListWidth } from './useFileListWidth';
export { useSyncProgress } from './useSyncProgress';
export { useDiffScope, type DiffScopeState } from './useDiffScope';
export { useChangedFiles, type ChangedFilesState } from './useChangedFiles';
export { useFileContent, type FileContentState } from './useFileContent';
export { useDiffComments, type DiffCommentsState } from './useDiffComments';
export { useBlame, type BlameState } from './useBlame';
export { useDraftAutoEdit, type DraftAutoEdit } from './useDraftAutoEdit';
export { useDiffNav, type PendingNav, type PendingScroll } from './useDiffNav';
export { useCommentZones } from './useCommentZones';
export { useDiffOverviewMarks } from './useDiffOverviewMarks';
export { useDraftZones } from './useDraftZones';
export { useLineCommentAdder } from './useLineCommentAdder';
export { useSelectionCapture } from './useSelectionCapture';
