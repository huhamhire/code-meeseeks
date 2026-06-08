import { useState } from 'react';
import { GITHUB_DOTCOM_API_BASE, type Config } from '@meebox/shared';
import { invoke } from '../api';
import { EyeIcon, EyeOffIcon } from './icons';

// 连接编辑用的扁平草稿（Connection 是嵌套的 auth/clone，拍平后表单好写），存盘前还原。
// 设置页 ConnectionEditorModal 与首启向导 PlatformStep 共用同一份草稿形状 + 表单。
export type ConnEntry = Config['connections'][number];
/** 当前支持配置的平台 kind（gitlab/gitea 尚未实现，不在草稿可选范围） */
export type ConnKind = 'bitbucket-server' | 'github';
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
  // GitHub 的 Base URL 可留空 → 默认官方 api.github.com（GHE 才需手填 /api/v3）。
  const trimmed = d.base_url.trim();
  const base_url = d.kind === 'github' && trimmed === '' ? GITHUB_DOTCOM_API_BASE : trimmed;
  const common = {
    id: d.id,
    base_url,
    display_name: d.display_name.trim() || base_url,
    auth: { type: 'pat' as const, token: d.token },
    clone: { protocol: d.protocol },
  };
  return d.kind === 'github'
    ? { ...common, kind: 'github' as const }
    : { ...common, kind: 'bitbucket-server' as const };
}

/** 各平台的字段文案（名称 / Base URL / 令牌 占位） */
const KIND_HINTS: Record<ConnKind, { name: string; baseUrl: string; token: string }> = {
  'bitbucket-server': {
    name: '如 公司 Bitbucket',
    baseUrl: 'https://bitbucket.example.com',
    token: 'Bitbucket HTTP 访问令牌',
  },
  github: {
    name: '如 公司 GitHub',
    baseUrl: '留空默认 https://api.github.com；GHE 填 https://<host>/api/v3',
    token: 'GitHub Personal Access Token',
  },
};

/** Base URL 形如 http(s)://… 才算合法；GitHub 允许留空（默认官方 api.github.com）。 */
export function connUrlValid(d: ConnDraft): boolean {
  const u = d.base_url.trim();
  if (d.kind === 'github' && u === '') return true;
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
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const update = <K extends keyof ConnDraft>(field: K, value: ConnDraft[K]): void => {
    onChange({ ...draft, [field]: value });
    setTestResult(null); // 改字段清掉旧测试结果，避免误导
  };

  const urlValid = connUrlValid(draft);
  const canTest = urlValid && draft.token.trim() !== '';
  const hints = KIND_HINTS[draft.kind];

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
              text: `连接成功${r.user ? ` · ${r.user.displayName}` : ''}${
                r.serverVersion ? ` · v${r.serverVersion}` : ''
              }`,
            }
          : { ok: false, text: r.reason ?? '连接失败' },
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
          名称 <span className="settings-required">*</span>
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
          {draft.kind === 'github' ? (
            <span className="settings-optional">(可选)</span>
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
          访问令牌 (PAT) <span className="settings-required">*</span>
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
              title={tokenVisible ? '隐藏' : '显示'}
              aria-label={tokenVisible ? '隐藏' : '显示'}
            >
              {tokenVisible ? <EyeIcon /> : <EyeOffIcon />}
            </button>
          </div>
        </div>
        <div className="modal-kv-key">Clone 协议</div>
        <div className="modal-kv-val">
          <select
            className="settings-input"
            value={draft.protocol}
            onChange={(e) => update('protocol', e.target.value as 'pat' | 'ssh')}
          >
            <option value="pat">HTTPS</option>
            <option value="ssh">SSH（本地 ssh config）</option>
          </select>
        </div>
      </div>
      {/* 测试连接：独立一行，左按钮右结果。保存 / 取消 由外层决定布局 */}
      <div className="settings-actions" style={{ marginTop: 12, alignItems: 'center' }}>
        <button type="button" className="btn" onClick={() => void runTest()} disabled={!canTest || testing}>
          {testing ? '测试中…' : '测试连接'}
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
