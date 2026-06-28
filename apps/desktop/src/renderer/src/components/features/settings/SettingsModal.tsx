import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo, AppPaths, Config, EditorTheme, SupportedLanguage } from '@meebox/shared';
import {
  ConfirmModal,
  CpuIcon,
  GlobeIcon,
  Modal,
  QuestionIcon,
  RobotIcon,
  SettingsIcon,
} from '../../common';
import { useSettingsDraft } from './hooks/useSettingsDraft';
import { useAppearanceDraft } from './hooks/useAppearanceDraft';
import { ConnectionEditorModal } from './editors/ConnectionEditorModal';
import { LlmEditorModal } from './editors/LlmEditorModal';
import { ProxyEditorModal } from './editors/ProxyEditorModal';
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
import { AgentDirSection } from './sections/AgentDirSection';
import { WorkDirSection } from './sections/WorkDirSection';
import { CacheDirSection } from './sections/CacheDirSection';
import { RuntimeSection } from './sections/RuntimeSection';

export type SettingsCategory = 'general' | 'connection' | 'model' | 'agent' | 'about';

/**
 * 配置分区导航元数据（左侧栏）。新增配置分区在此登记一项，并在右侧面板的 switch
 * 中渲染对应 section —— 分区结构为后续扩展（主题 / 编辑器 / 上下文窗口等）预留。
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
  { id: 'about', labelKey: 'settings.catAbout', Icon: QuestionIcon },
];

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** LLM 配置改动后通知父级同步状态（StatusBar chip 等） */
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  /** UI 语言即时切换后通知父级同步 boot.config.language（与写盘/实时切换解耦的状态同步） */
  onLanguageChange?: (language: SupportedLanguage) => void;
  /** 外观（全局主题 + 等宽字体 + 字号）即时改动后通知父级同步 boot.config.appearance */
  onEditorAppearanceChange?: (appearance: {
    editor_theme: EditorTheme;
    editor_font_family: string;
    editor_font_size: number;
  }) => void;
  /**
   * 连接改动（含切换活动连接）保存成功后通知父级。父级需重拉 config + 连接摘要 + PR 列表：
   * 活动连接变化后，main 端 app:connections 只返回新活动连接的摘要、prs:list 只返回其 PR，
   * 不刷新的话 App 的 boot.connections / 列表会过期（丢 capabilities/user、PR 对不上）。
   */
  onConnectionsChange?: () => void | Promise<void>;
  /** 整体保存成功后回传写盘后的权威 config，父级据此同步 boot.config（再次打开设置页显示最新值）。 */
  onConfigPersisted?: (config: Config) => void;
  /** 打开时的初始分区（命令面板「打开关于」等深链用）；缺省 'general'。 */
  initialCategory?: SettingsCategory;
  onClose: () => void;
}

/**
 * 设置面板（容器）：布局编排 + 装配各分区。草稿 / 保存状态机归 useSettingsDraft，
 * 各设置分区拆到 sections/，连接 / 代理 / LLM 编辑器拆到 editors/，通用模态壳用 common/Modal。
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
  // 已挂载时再次以新初始分区打开（命令面板深链）：切到目标分区；用户在面板内手动导航仍走 setCategory。
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
  // 外观类即时生效设置（语言 / 主题 / 编辑器外观）：与整体保存事务正交，独立 hook 管理。
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
            {/* 模型：仅 LLM 连接 + 上下文长度。 */}
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
            {/* 智能体：记忆目录 + 策略 + 评审并发。 */}
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
                />
                <ConcurrencySection
                  value={s.maxConcurrencyInput}
                  onChange={s.setMaxConcurrency}
                />
              </>
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
