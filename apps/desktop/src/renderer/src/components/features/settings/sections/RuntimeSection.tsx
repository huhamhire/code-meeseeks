import { useTranslation } from 'react-i18next';
import type { AppInfo } from '@meebox/shared';
import { GitHubMarkIcon, IssueIcon, TagIcon } from '../../../common';
import { invoke } from '../../../../api';
import { UpdateCheckButton } from '../elements/UpdateCheckButton';

export function RuntimeSection({ info, updateEnabled }: { info: AppInfo; updateEnabled: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <h4>{t('settings.runtimeTitle')}</h4>
      <div className="modal-kv">
        <div className="modal-kv-key">{t('settings.appVersion')}</div>
        <div className="modal-kv-val">{info.appVersion}</div>
        <div className="modal-kv-key">Electron</div>
        <div className="modal-kv-val">{info.electronVersion}</div>
        <div className="modal-kv-key">Node</div>
        <div className="modal-kv-val">{info.nodeVersion}</div>
        <div className="modal-kv-key">{t('settings.platform')}</div>
        <div className="modal-kv-val">{info.platform}</div>
      </div>
      <div className="settings-actions" style={{ marginTop: 10, alignItems: 'center' }}>
        <UpdateCheckButton enabled={updateEnabled} />
        <button
          className="btn"
          type="button"
          style={{ marginLeft: 'auto' }}
          onClick={() => void invoke('app:openDevTools', undefined)}
          title={t('settings.openDevToolsTitle')}
        >
          {t('settings.openDevTools')}
        </button>
      </div>
      {/* 关于 & 反馈：低频社区链接。http(s) 外链由 App 顶层点击拦截走 openExternal 在系统浏览器打开。 */}
      <div className="settings-about-links">
        <span className="muted settings-about-label">{t('settings.aboutFeedback')}</span>
        <a
          className="settings-about-link"
          href="https://github.com/huhamhire/code-meeseeks"
          target="_blank"
          rel="noreferrer"
        >
          <GitHubMarkIcon size={14} />
          {t('settings.starOnGithub')}
        </a>
        <a
          className="settings-about-link"
          href="https://github.com/huhamhire/code-meeseeks/issues/new"
          target="_blank"
          rel="noreferrer"
        >
          <IssueIcon size={14} />
          {t('settings.reportIssue')}
        </a>
        <a
          className="settings-about-link"
          href="https://github.com/huhamhire/code-meeseeks/releases"
          target="_blank"
          rel="noreferrer"
        >
          <TagIcon size={14} />
          {t('settings.releases')}
        </a>
      </div>
    </section>
  );
}
