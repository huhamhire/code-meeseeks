import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo } from '@meebox/shared';
import { CheckGlyphIcon, CopyIcon, GitHubMarkIcon, IssueIcon, TagIcon } from '../../../common';
import { invoke } from '../../../../api';
import { UpdateCheckButton } from '../elements/UpdateCheckButton';

export function RuntimeSection({ info, updateEnabled }: { info: AppInfo; updateEnabled: boolean }) {
  const { t } = useTranslation();
  // 复制后短暂切到「打勾 + 已复制」绿色态作反馈（无 toast 体系，按钮内联反馈）。
  const [copied, setCopied] = useState(false);

  // 操作系统：平台代号 + 系统版本合并展示（如「darwin 15.5」）。
  const osText = `${info.platform} ${info.osVersion}`.trim();

  // 整体运行环境信息的纯文本快照（每行「键: 值」），供一键复制粘贴到 issue / 反馈。
  const infoText = [
    `${t('settings.appVersion')}: ${info.appVersion}`,
    `Electron: ${info.electronVersion}`,
    `Node: ${info.nodeVersion}`,
    `${t('settings.operatingSystem')}: ${osText}`,
    `${t('settings.architecture')}: ${info.arch}`,
  ].join('\n');

  const copyInfo = (): void => {
    void navigator.clipboard.writeText(infoText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <div className="modal-section-head-title">
          <h4>{t('settings.runtimeTitle')}</h4>
          <button
            type="button"
            className={`btn btn-sm btn-icon settings-copy-info${copied ? ' is-copied' : ''}`}
            onClick={copyInfo}
            title={t('settings.copyInfoTitle')}
            aria-label={t('settings.copyInfo')}
          >
            {copied ? <CheckGlyphIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </div>
      </div>
      <div className="modal-kv">
        <div className="modal-kv-key">{t('settings.appVersion')}</div>
        <div className="modal-kv-val">{info.appVersion}</div>
        <div className="modal-kv-key">Electron</div>
        <div className="modal-kv-val">{info.electronVersion}</div>
        <div className="modal-kv-key">Node</div>
        <div className="modal-kv-val">{info.nodeVersion}</div>
        <div className="modal-kv-key">{t('settings.operatingSystem')}</div>
        <div className="modal-kv-val">{osText}</div>
        <div className="modal-kv-key">{t('settings.architecture')}</div>
        <div className="modal-kv-val">{info.arch}</div>
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
