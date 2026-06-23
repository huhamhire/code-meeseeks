import { useTranslation } from 'react-i18next';
import type { AppInfo, AppPaths, Config, SupportedLanguage } from '@meebox/shared';
import { ConfirmModal, Modal } from '../../common';
import { useSettingsDraft } from './hooks/useSettingsDraft';
import { ConnectionEditorModal } from './editors/ConnectionEditorModal';
import { LlmEditorModal } from './editors/LlmEditorModal';
import { ProxyEditorModal } from './editors/ProxyEditorModal';
import { LanguageSection } from './sections/LanguageSection';
import { ConnectionsSection } from './sections/ConnectionsSection';
import { PollerSection } from './sections/PollerSection';
import { LlmSection } from './sections/LlmSection';
import { ProxySection } from './sections/ProxySection';
import { AgentDirSection } from './sections/AgentDirSection';
import { WorkDirSection } from './sections/WorkDirSection';
import { CacheDirSection } from './sections/CacheDirSection';
import { RuntimeSection } from './sections/RuntimeSection';

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** LLM 配置改动后通知父级同步状态（StatusBar chip 等） */
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  /** UI 语言即时切换后通知父级同步 boot.config.language（与写盘/实时切换解耦的状态同步） */
  onLanguageChange?: (language: SupportedLanguage) => void;
  /**
   * 连接改动（含切换活动连接）保存成功后通知父级。父级需重拉 config + 连接摘要 + PR 列表：
   * 活动连接变化后，main 端 app:connections 只返回新活动连接的摘要、prs:list 只返回其 PR，
   * 不刷新的话 App 的 boot.connections / 列表会过期（丢 capabilities/user、PR 对不上）。
   */
  onConnectionsChange?: () => void | Promise<void>;
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
  onConnectionsChange,
  onClose,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const s = useSettingsDraft({
    config,
    paths,
    onLlmChange,
    onProxyChange,
    onLanguageChange,
    onConnectionsChange,
    onClose,
  });

  return (
    <>
      <Modal
        size="md"
        onClose={onClose}
        title={t('settings.title')}
        headerClose="icon"
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
              {(s.saveError ?? s.openError) && (
                <span className="error-text">{s.saveError ?? s.openError}</span>
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
        <LanguageSection language={s.language} onChange={s.handleLanguageChange} />
        <ConnectionsSection
          connections={s.connections}
          activeConnId={s.activeConnId}
          onAdd={s.openAddConn}
          onEdit={s.openEditConn}
          onSetActive={s.setActiveConn}
          onRequestDelete={s.setConnDeleteId}
        />
        <PollerSection value={s.pollerInput} onChange={s.setPoller} />
        <LlmSection
          llm={s.llm}
          onAdd={s.openAddProfile}
          onEdit={s.openEditProfile}
          onSetActive={s.setActiveLlm}
          onDelete={s.deleteProfile}
        />
        <ProxySection proxy={s.proxy} onConfigure={() => s.setProxyEditor(s.proxy)} />
        <AgentDirSection
          value={s.agentDirInput}
          onChange={s.setAgentDir}
          onPick={() => void s.pickAgentDir()}
        />
        <WorkDirSection paths={paths} />
        <CacheDirSection
          paths={paths}
          value={s.reposDirInput}
          onChange={s.setReposDir}
          onPick={() => void s.pickReposDir()}
          totalBytes={s.totalBytes}
        />
        <RuntimeSection info={info} updateEnabled={config.update.check_enabled} />
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
