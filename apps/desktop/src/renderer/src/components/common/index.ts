// components/common public API barrel: generic presentational components + icons + markdown rendering utilities.
// Cross-domain consumers (features/* · layout/* · App etc.) import via this barrel; common's internal modules reference each other
// (markdownMermaid → MermaidDiagram, Modal → icons, ConfirmModal → Modal) via relative paths,
// not through this barrel, to avoid circular dependencies.
export * from './Avatar';
export * from './BitbucketImage';
export * from './ConfirmModal';
export * from './ErrorBoundary';
export * from './LlmProviderIcon';
export * from './Loading';
export * from './MermaidDiagram';
export * from './Modal';
export * from './PlatformIcon';
export * from './StatusChip';
export * from './Switch';
export * from './icons';
export * from './markdownMermaid';
