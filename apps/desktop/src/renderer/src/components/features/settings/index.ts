// features/settings 对外公共 API：设置面板 + 连接 / LLM 表单（onboarding 复用）。
// 内部模块（sections / editors / hooks 等）相互引用走相对路径。状态栏 chip 走 statusbar/* 子路径。
export { SettingsModal } from './SettingsModal';
export {
  ConnectionForm,
  connDraftCanSave,
  fromConnDraft,
  type ConnDraft,
  type ConnEntry,
} from './ConnectionForm';
export { LlmProfileForm, newProfileId, LLM_PROVIDERS } from './LlmProfileForm';
