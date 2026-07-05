import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo, AppPaths, Config, EditorTheme, SupportedLanguage } from '@meebox/shared';
import {
  BellIcon,
  ConfirmModal,
  CpuIcon,
  GlobeIcon,
  Modal,
  PuzzleIcon,
  QuestionIcon,
  RobotIcon,
  SettingsIcon,
} from '../../common';
import { useSettingsDraft } from './hooks/useSettingsDraft';
import { useAppearanceDraft } from './hooks/useAppearanceDraft';
import { ConnectionEditorModal } from './editors/ConnectionEditorModal';
import { LlmEditorModal } from './editors/LlmEditorModal';
import { ProxyEditorModal } from './editors/ProxyEditorModal';
import { TemplateEditorModal } from './editors/TemplateEditorModal';
import { LanguageSection } from './sections/LanguageSection';
import { ThemeSection } from './sections/ThemeSection';
import { EditorSection } from './sections/EditorSection';
import { ConnectionsSection } from './sections/ConnectionsSection';
import { PollerSection } from './sections/PollerSection';
import { LlmSection } from './sections/LlmSection';
import { LlmContextSection } from './sections/LlmContextSection';
import { ConcurrencySection } from './sections/ConcurrencySection';
import { AgentStrategySection } from './sections/AgentStrategySection';
import { ProxySection } from './sections/ProxySection';
import { ServiceSection } from './sections/ServiceSection';
import { AgentDirSection } from './sections/AgentDirSection';
import { WorkDirSection } from './sections/WorkDirSection';
import { CacheDirSection } from './sections/CacheDirSection';
import { NotificationSection } from './sections/NotificationSection';
import { RuntimeSection } from './sections/RuntimeSection';

export type SettingsCategory =
  | 'general'
  | 'connection'
  | 'model'
  | 'agent'
  | 'notifications'
  | 'integration'
  | 'about';

/**
 * Settings-section nav metadata (left sidebar). Register a new settings section here and render
 * the corresponding section in the right panel's switch — the section structure is reserved for future extensions (theme / editor / context window etc.).
 */
const SETTINGS_CATEGORIES: ReadonlyArray<{
  id: SettingsCategory;
  labelKey: string;
  Icon: typeof SettingsIcon;
}> = [
  { id: 'general', labelKey: 'settings.catGeneral', Icon: SettingsIcon },
  { id: 'connection', labelKey: 'settings.catConnection', Icon: GlobeIcon },
  { id: 'model', labelKey: 'settings.catModel', Icon: CpuIcon },
  { id: 'agent', labelKey: 'settings.catAgent', Icon: RobotIcon },
  { id: 'notifications', labelKey: 'settings.catNotifications', Icon: BellIcon },
  { id: 'integration', labelKey: 'settings.catIntegration', Icon: PuzzleIcon },
  { id: 'about', labelKey: 'settings.catAbout', Icon: QuestionIcon },
];

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** Notify the parent to sync state (StatusBar chip etc.) after LLM config changes */
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  /** Notify the parent to sync boot.config.language after an instant UI-language switch (state sync decoupled from write-to-disk / live switching) */
  onLanguageChange?: (language: SupportedLanguage) => void;
  /** Notify the parent to sync boot.config.appearance after an instant appearance change (global theme + monospace font + font size) */
  onEditorAppearanceChange?: (appearance: {
    editor_theme: EditorTheme;
    editor_font_family: string;
    editor_font_size: number;
  }) => void;
  /**
   * Notify the parent after a connection change (including switching the active connection) is saved successfully. The parent needs to re-fetch config + connection summary + PR list:
   * after the active connection changes, the main side's app:connections only returns the new active connection's summary and prs:list only returns its PRs,
   * without refreshing, the App's boot.connections / list goes stale (loses capabilities/user, PRs don't match).
   */
  onConnectionsChange?: () => void | Promise<void>;
  /** After a full save succeeds, pass back the authoritative config after write-to-disk; the parent syncs boot.config from it (so reopening settings shows the latest values). */
  onConfigPersisted?: (config: Config) => void;
  /** Initial section on open (used by deep links like the command palette's "open About"); defaults to 'general'. */
  initialCategory?: SettingsCategory;
  onClose: () => void;
}

/**
 * Settings panel (container): layout orchestration + assembling the sections. The draft / save state machine belongs to useSettingsDraft,
 * each settings section is split into sections/, the connection / proxy / LLM editors into editors/, and the generic modal shell uses common/Modal.
 */
export function SettingsModal({
  info,
  paths,
  config,
  onLlmChange,
  onProxyChange,
  onLanguageChange,
  onEditorAppearanceChange,
  onConnectionsChange,
  onConfigPersisted,
  initialCategory,
  onClose,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory ?? 'general');
  // Reopening with a new initial section while already mounted (command-palette deep link): switch to the target section; manual navigation within the panel still goes through setCategory.
  useEffect(() => {
    if (initialCategory) setCategory(initialCategory);
  }, [initialCategory]);
  const s = useSettingsDraft({
    config,
    paths,
    onLlmChange,
    onProxyChange,
    onConnectionsChange,
    onConfigPersisted,
    onClose,
  });
  // Appearance-type instantly-applied settings (language / theme / editor appearance): orthogonal to the full-save transaction, managed by a separate hook.
  const a = useAppearanceDraft({
    config,
    onLanguageChange,
    onEditorAppearanceChange,
  });

  return (
    <>
      <Modal
        size="lg"
        onClose={onClose}
        // Accidentally closing via a backdrop click with an unsaved draft loses config: the settings page disables backdrop-click close, exit only via the top-right close button (or a successful save).
        closeOnBackdrop={false}
        title={t('settings.title')}
        headerClose="icon"
        bodyClassName="settings-modal-body"
        footer={
          <>
            <div className="modal-footer-left">
              <button
                className="btn"
                type="button"
                onClick={() => void s.openConfigFile()}
                disabled={s.opening}
              >
                {s.opening ? t('settings.opening') : t('settings.editConfigYaml')}
              </button>
            </div>
            <div className="modal-footer-right">
              {(s.saveError ?? s.openError ?? a.error) && (
                <span className="error-text">{s.saveError ?? s.openError ?? a.error}</span>
              )}
              {s.saved && !s.anyChanged && <span className="muted">{t('settings.saved')}</span>}
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void s.saveAll()}
                disabled={!s.anyChanged || s.saving}
              >
                {s.saving ? t('settings.saving') : t('common.save')}
              </button>
            </div>
          </>
        }
      >
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('settings.title')}>
            {SETTINGS_CATEGORIES.map(({ id, labelKey, Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-item${category === id ? ' active' : ''}`}
                aria-current={category === id ? 'page' : undefined}
                onClick={() => setCategory(id)}
              >
                <Icon size={18} />
                <span>{t(labelKey)}</span>
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {category === 'general' && (
              <>
                <LanguageSection language={a.language} onChange={a.handleLanguageChange} />
                <ThemeSection theme={a.editorTheme} onChange={a.handleEditorThemeChange} />
                <EditorSection
                  fontFamily={a.editorFontFamily}
                  fontSize={a.editorFontSize}
                  onFontChange={a.handleEditorFontChange}
                  onFontCommit={a.commitEditorFont}
                  onFontSizeChange={a.handleEditorFontSizeChange}
                />
              </>
            )}
            {category === 'connection' && (
              <>
                <ConnectionsSection
                  connections={s.connections}
                  activeConnId={s.activeConnId}
                  onAdd={s.openAddConn}
                  onEdit={s.openEditConn}
                  onSetActive={s.setActiveConn}
                  onRequestDelete={s.setConnDeleteId}
                />
                <PollerSection value={s.pollerInput} onChange={s.setPoller} />
                <ProxySection proxy={s.proxy} onConfigure={() => s.setProxyEditor(s.proxy)} />
                <CacheDirSection
                  paths={paths}
                  value={s.reposDirInput}
                  onChange={s.setReposDir}
                  onPick={() => void s.pickReposDir()}
                  totalBytes={s.totalBytes}
                />
              </>
            )}
            {/* Model: only LLM connections + context length. */}
            {category === 'model' && (
              <>
                <LlmSection
                  llm={s.llm}
                  onAdd={s.openAddProfile}
                  onEdit={s.openEditProfile}
                  onSetActive={s.setActiveLlm}
                  onDelete={s.deleteProfile}
                />
                <LlmContextSection
                  value={s.llm.context_tokens}
                  onChange={s.setLlmContextTokens}
                />
              </>
            )}
            {/* Agent: memory directory + strategy + review concurrency. */}
            {category === 'agent' && (
              <>
                <AgentDirSection
                  value={s.agentDirInput}
                  onChange={s.setAgentDir}
                  onPick={() => void s.pickAgentDir()}
                />
                <AgentStrategySection
                  autoFollowup={s.autoFollowup}
                  onAutoFollowupChange={s.setAutoFollowup}
                  maxFollowupAsks={s.maxFollowupAsks}
                  onMaxFollowupAsksChange={s.setMaxFollowupAsks}
                  maxCodeSuggestions={s.maxCodeSuggestions}
                  onMaxCodeSuggestionsChange={s.setMaxCodeSuggestions}
                  codeSuggestionSpec={s.codeSuggestionSpec}
                  onEditCodeSuggestionSpec={() =>
                    s.setTemplateEditor({ field: 'spec', draft: s.codeSuggestionSpec })
                  }
                  codeSuggestionLayout={s.codeSuggestionLayout}
                  onEditCodeSuggestionLayout={() =>
                    s.setTemplateEditor({ field: 'layout', draft: s.codeSuggestionLayout })
                  }
                />
                <ConcurrencySection
                  value={s.maxConcurrencyInput}
                  onChange={s.setMaxConcurrency}
                />
              </>
            )}
            {category === 'notifications' && (
              <NotificationSection value={s.notifications} onChange={s.setNotifications} />
            )}
            {category === 'integration' && (
              <ServiceSection
                value={s.service}
                onChange={s.setService}
                onRegenerateToken={() => void s.regenerateServiceToken()}
              />
            )}
            {category === 'about' && (
              <>
                <WorkDirSection paths={paths} />
                <RuntimeSection info={info} updateEnabled={config.update.check_enabled} />
              </>
            )}
          </div>
        </div>
      </Modal>

      {s.llmEditor && (
        <LlmEditorModal
          state={s.llmEditor}
          existing={s.llm.profiles}
          onChange={(draft) => s.setLlmEditor({ ...s.llmEditor!, draft })}
          onSave={() => void s.saveLlmEditor()}
          onCancel={s.closeLlmEditor}
        />
      )}
      {s.connEditor && (
        <ConnectionEditorModal
          state={s.connEditor}
          onChange={(draft) => s.setConnEditor({ ...s.connEditor!, draft })}
          onSave={() => s.saveConnEditor()}
          onCancel={() => s.setConnEditor(null)}
        />
      )}
      {s.proxyEditor && (
        <ProxyEditorModal
          draft={s.proxyEditor}
          onChange={s.setProxyEditor}
          onSave={() => s.saveProxyEditor()}
          onCancel={() => s.setProxyEditor(null)}
        />
      )}
      {s.templateEditor && (
        <TemplateEditorModal
          field={s.templateEditor.field}
          draft={s.templateEditor.draft}
          onChange={(next) => s.setTemplateEditor({ ...s.templateEditor!, draft: next })}
          onSave={s.saveTemplateEditor}
          onCancel={() => s.setTemplateEditor(null)}
        />
      )}
      {s.connDeleteId && (
        <ConfirmModal
          title={t('settings.deleteConnectionConfirmTitle')}
          message={t('settings.deleteConnectionConfirmMessage', {
            name:
              s.connections.find((c) => c.id === s.connDeleteId)?.display_name || s.connDeleteId,
          })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => {
            s.deleteConn(s.connDeleteId!);
            s.setConnDeleteId(null);
          }}
          onCancel={() => s.setConnDeleteId(null)}
        />
      )}
    </>
  );
}
