// features/settings public API: settings panel + connection / LLM forms (reused by onboarding).
// Internal modules (sections / editors / hooks etc.) reference each other via relative paths. Status-bar chips go through the statusbar/* subpath.
export { SettingsModal, type SettingsCategory } from './SettingsModal';
export {
  ConnectionForm,
  connDraftCanSave,
  fromConnDraft,
  type ConnDraft,
  type ConnEntry,
} from './ConnectionForm';
export { LlmProfileForm, newProfileId, LLM_PROVIDERS } from './LlmProfileForm';
export { PlatformPicker } from './pickers/PlatformPicker';
export { LlmProviderPicker } from './pickers/LlmProviderPicker';
