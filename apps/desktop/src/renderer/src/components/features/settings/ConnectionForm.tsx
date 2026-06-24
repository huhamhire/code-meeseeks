import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { GITHUB_DOTCOM_API_BASE, GITLAB_DOTCOM_API_BASE, type Config } from '@meebox/shared';
import { invoke } from '../../../api';
import { formatBackendError } from '../../../errors';
import { EyeIcon, EyeOffIcon } from '../../common';

// 连接编辑用的扁平草稿（Connection 是嵌套的 auth/clone，拍平后表单好写），存盘前还原。
// 设置页 ConnectionEditorModal 与首启向导 PlatformStep 共用同一份草稿形状 + 表单。
export type ConnEntry = Config['connections'][number];
/** 当前支持配置的平台 kind */
export type ConnKind = 'github' | 'bitbucket-server' | 'gitlab';
export type ConnDraft = {
  id: string;
  kind: ConnKind;
  display_name: string;
  base_url: string;
  token: string;
  protocol: 'pat' | 'ssh';
};

export function toConnDraft(c: ConnEntry): ConnDraft {
  return {
    id: c.id,
    kind: c.kind,
    display_name: c.display_name,
    base_url: c.base_url,
    token: c.auth.token,
    protocol: c.clone.protocol,
  };
}

export function fromConnDraft(d: ConnDraft): ConnEntry {
  // GitHub / GitLab 的 Base URL 可留空 → 默认官方 endpoint（GHE / 自建实例才需手填）。
  const trimmed = d.base_url.trim();
  const base_url =
    trimmed === '' && d.kind === 'github'
      ? GITHUB_DOTCOM_API_BASE
      : trimmed === '' && d.kind === 'gitlab'
        ? GITLAB_DOTCOM_API_BASE
        : trimmed;
  const common = {
    id: d.id,
    base_url,
    display_name: d.display_name.trim() || base_url,
    auth: { type: 'pat' as const, token: d.token },
    clone: { protocol: d.protocol },
  };
  return d.kind === 'github'
    ? { ...common, kind: 'github' as const }
    : d.kind === 'gitlab'
      ? { ...common, kind: 'gitlab' as const }
      : { ...common, kind: 'bitbucket-server' as const };
}

/** 各平台的字段文案（名称 / Base URL / 令牌 占位） */
function kindHints(
  t: TFunction,
): Record<ConnKind, { name: string; baseUrl: string; token: string }> {
  return {
    github: {
      name: t('connectionForm.githubNamePlaceholder'),
      baseUrl: t('connectionForm.githubBaseUrlPlaceholder'),
      token: t('connectionForm.githubTokenPlaceholder'),
    },
    'bitbucket-server': {
      name: t('connectionForm.bitbucketNamePlaceholder'),
      baseUrl: t('connectionForm.bitbucketBaseUrlPlaceholder'),
      token: t('connectionForm.bitbucketTokenPlaceholder'),
    },
    gitlab: {
      name: t('connectionForm.gitlabNamePlaceholder'),
      baseUrl: t('connectionForm.gitlabBaseUrlPlaceholder'),
      token: t('connectionForm.gitlabTokenPlaceholder'),
    },
  };
}

/** Base URL 形如 http(s)://… 才算合法；GitHub / GitLab 允许留空（默认官方 endpoint）。 */
export function connUrlValid(d: ConnDraft): boolean {
  const u = d.base_url.trim();
  if ((d.kind === 'github' || d.kind === 'gitlab') && u === '') return true;
  return /^https?:\/\/.+/i.test(u);
}
/** 名称 + 合法 URL + token 三者齐全才允许保存 */
export function connDraftCanSave(d: ConnDraft): boolean {
  return d.display_name.trim() !== '' && connUrlValid(d) && d.token.trim() !== '';
}

/**
 * 连接配置受控表单（名称 / Base URL / PAT / Clone 协议 + 「测试连接」）。
 * 只负责字段渲染与即时连通性测试；保存 / 取消等动作由外层（模态框 / 向导）提供。
 *
 * autoFocus 默认开（模态打开聚焦名称）；嵌在向导里时按需关闭避免抢焦点。
 */
export function ConnectionForm({
  draft,
  onChange,
  autoFocus = true,
}: {
  draft: ConnDraft;
  onChange: (draft: ConnDraft) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const update = <K extends keyof ConnDraft>(field: K, value: ConnDraft[K]): void => {
    onChange({ ...draft, [field]: value });
    setTestResult(null); // 改字段清掉旧测试结果，避免误导
  };

  const urlValid = connUrlValid(draft);
  const canTest = urlValid && draft.token.trim() !== '';
  const hints = kindHints(t)[draft.kind];

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await invoke('config:testConnection', {
        base_url: draft.base_url.trim(),
        token: draft.token,
        kind: draft.kind,
      });
      setTestResult(
        r.ok
          ? {
              ok: true,
              text: `${t('connectionForm.testSuccess')}${r.user ? ` · ${r.user.displayName}` : ''}${
                r.serverVersion ? ` · v${r.serverVersion}` : ''
              }`,
            }
          : {
              ok: false,
              text: r.reason ? formatBackendError(r.reason).title : t('connectionForm.testFailed'),
            },
      );
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="modal-kv">
        <div className="modal-kv-key">
          {t('connectionForm.nameLabel')} <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className="settings-input"
            value={draft.display_name}
            onChange={(e) => update('display_name', e.target.value)}
            placeholder={hints.name}
            autoFocus={autoFocus}
            maxLength={48}
          />
        </div>
        <div className="modal-kv-key">
          Base URL{' '}
          {draft.kind === 'github' || draft.kind === 'gitlab' ? (
            <span className="settings-optional">{t('connectionForm.optional')}</span>
          ) : (
            <span className="settings-required">*</span>
          )}
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className={`settings-input${draft.base_url && !urlValid ? ' settings-input-error' : ''}`}
            value={draft.base_url}
            onChange={(e) => update('base_url', e.target.value)}
            placeholder={hints.baseUrl}
          />
        </div>
        <div className="modal-kv-key">
          {t('connectionForm.tokenLabel')} <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <div className="settings-secret-row">
            <input
              type={tokenVisible ? 'text' : 'password'}
              className="settings-input"
              value={draft.token}
              onChange={(e) => update('token', e.target.value)}
              placeholder={hints.token}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-sm btn-icon"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? t('connectionForm.hide') : t('connectionForm.show')}
              aria-label={tokenVisible ? t('connectionForm.hide') : t('connectionForm.show')}
            >
              {tokenVisible ? <EyeIcon /> : <EyeOffIcon />}
            </button>
          </div>
        </div>
        <div className="modal-kv-key">{t('connectionForm.cloneProtocolLabel')}</div>
        <div className="modal-kv-val">
          <select
            className="settings-input"
            value={draft.protocol}
            onChange={(e) => update('protocol', e.target.value as 'pat' | 'ssh')}
          >
            <option value="pat">HTTPS</option>
            <option value="ssh">{t('connectionForm.cloneProtocolSsh')}</option>
          </select>
        </div>
      </div>
      {/* 测试连接：独立一行，左按钮右结果。保存 / 取消 由外层决定布局 */}
      <div className="settings-actions" style={{ marginTop: 12, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void runTest()}
          disabled={!canTest || testing}
        >
          {testing ? t('connectionForm.testing') : t('connectionForm.testConnection')}
        </button>
        {testResult && (
          <span
            className={testResult.ok ? undefined : 'error-text'}
            style={testResult.ok ? { color: '#3fb950' } : undefined}
          >
            {testResult.text}
          </span>
        )}
      </div>
    </>
  );
}
