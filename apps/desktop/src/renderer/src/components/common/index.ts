// components/common 对外公共 API barrel：通用展示组件 + 图标 + markdown 渲染工具。
// 跨域消费方（features/* · layout/* · App 等）经此 barrel 引入；common 内部模块相互引用
// （markdownMermaid → MermaidDiagram、Modal → icons、ConfirmModal → Modal）走相对路径，
// 不经此 barrel，避免循环依赖。
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
export * from './icons';
export * from './markdownMermaid';
