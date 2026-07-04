import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo, PrAgentStatus } from '@meebox/shared';
import { CheckGlyphIcon, CopyIcon, GitHubMarkIcon, IssueIcon, TagIcon } from '../../../common';
import { invoke } from '../../../../api';
import { UpdateCheckButton } from '../elements/UpdateCheckButton';

export function RuntimeSection({ info, updateEnabled }: { info: AppInfo; updateEnabled: boolean }) {
  const { t } = useTranslation();
  // After copying, briefly switch to a green "check + copied" state as feedback (no toast system, inline button feedback).
  const [copied, setCopied] = useState(false);
  // pr-agent runtime status: de-emphasized from the status bar down to here for on-demand display, fetched when the about page opens.
  const [prAgent, setPrAgent] = useState<PrAgentStatus | null>(null);
  useEffect(() => {
    void invoke('app:prAgentStatus', undefined)
      .then(setPrAgent)
      .catch(() => setPrAgent(null));
  }, []);
  // Only show the version number (not the embedded/local-cli run strategy — meaningless to the user): embedded version looks like
  // `pr-agent 0.36.0` → take `0.36.0`; local-cli is the first help line → truncate before the first whitespace.
  const prAgentVer = prAgent?.available
    ? prAgent.strategy === 'embedded'
      ? prAgent.version.replace(/^pr-agent\s+/, '')
      : prAgent.version.split(/\s+/)[0] || prAgent.version
    : null;
  const prAgentText = prAgent ? (prAgentVer ?? t('statusBar.prAgentUnavailable')) : '…';

  // Operating system: platform code + system version shown combined (e.g. "darwin 15.5").
  const osText = `${info.platform} ${info.osVersion}`.trim();

  // Plain-text snapshot of the overall runtime environment info (each line "key: value"), for one-click copy-paste into issues / feedback.
  const infoText = [
    `${t('settings.appVersion')}: ${info.appVersion}`,
    `Electron: ${info.electronVersion}`,
    `Node: ${info.nodeVersion}`,
    `${t('settings.operatingSystem')}: ${osText}`,
    `${t('settings.architecture')}: ${info.arch}`,
    `PR-Agent: ${prAgentText}`,
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
        <div className="modal-kv-key">PR-Agent</div>
        <div className="modal-kv-val">{prAgentText}</div>
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
      {/* About & feedback: low-frequency community links. http(s) external links are intercepted by the App top-level click and routed through openExternal to open in the system browser. */}
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
