import { useEffect, useState } from 'react';
import type { PrCommit, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../api';
import { formatBackendError, type FormattedError } from '../errors';
import { Avatar } from './Avatar';

interface CommitsPanelProps {
  pr: StoredPullRequest;
}

/**
 * PR commits 列表，表格布局。来源 `diff:listCommits` (无缓存，进入面板时拉一次)。
 *
 * 列：短 SHA / 提交主题 (commit message 首行) / 作者 / 时间。merge commit 用
 * 标记 chip 区分。点击行打开远端 commit 详情页 (BBS commit URL)。
 *
 * 列表默认按平台返回顺序 (newest first)，跟 git log 习惯一致。
 */
export function CommitsPanel({ pr }: CommitsPanelProps) {
  const [commits, setCommits] = useState<PrCommit[] | null>(null);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    setError(null);
    void (async () => {
      try {
        const list = await invoke('diff:listCommits', { localId: pr.localId });
        if (!cancelled) setCommits(list);
      } catch (e) {
        if (!cancelled) setError(formatBackendError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pr.localId]);

  if (error) {
    return (
      <div className="pr-commits-panel">
        <div className="pr-commits-error" role="alert">
          <strong>提交记录加载失败 · {error.title}</strong>
          <pre>{error.detail}</pre>
        </div>
      </div>
    );
  }
  if (commits === null) {
    return (
      <div className="pr-commits-panel">
        <p className="muted">加载提交记录中…</p>
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="pr-commits-panel">
        <p className="muted">这条 PR 没有提交记录</p>
      </div>
    );
  }

  return (
    <div className="pr-commits-panel">
      <table className="pr-commits-table">
        <thead>
          <tr>
            <th className="pr-commits-col-sha">提交</th>
            <th className="pr-commits-col-subject">提交主题</th>
            <th className="pr-commits-col-author">作者</th>
            <th className="pr-commits-col-time">时间</th>
          </tr>
        </thead>
        <tbody>
          {commits.map((c) => (
            <CommitRow key={c.sha} commit={c} pr={pr} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommitRow({ commit, pr }: { commit: PrCommit; pr: StoredPullRequest }) {
  const isMerge = commit.parents.length > 1;
  const subject = commit.message.split('\n', 1)[0]!;
  const open = (): void => {
    if (commit.url) window.open(commit.url, '_blank', 'noreferrer');
  };
  return (
    <tr
      className={`pr-commits-row ${commit.url ? 'pr-commits-row-clickable' : ''}`}
      onClick={open}
      title={commit.message /* 完整 commit body hover 可见 */}
    >
      <td className="pr-commits-col-sha">
        <code>{commit.abbreviatedSha}</code>
        {isMerge && (
          <span className="pr-commits-merge-tag" title={`merge commit (${String(commit.parents.length)} parents)`}>
            merge
          </span>
        )}
      </td>
      <td className="pr-commits-col-subject">{subject}</td>
      <td className="pr-commits-col-author">
        <Avatar
          connectionId={pr.connectionId}
          slug={commit.author.slug ?? commit.author.name}
          displayName={commit.author.displayName}
          size={20}
        />
        <span>{commit.author.displayName}</span>
      </td>
      <td className="pr-commits-col-time">
        <time dateTime={commit.authoredAt}>{formatCommitTime(commit.authoredAt)}</time>
      </td>
    </tr>
  );
}

function formatCommitTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${String(Math.round(diffSec / 60))} 分钟前`;
  if (diffSec < 86400) return `${String(Math.round(diffSec / 3600))} 小时前`;
  if (diffSec < 86400 * 7) return `${String(Math.round(diffSec / 86400))} 天前`;
  // 一周以上展示 yyyy-mm-dd，避免"X 周前"模糊
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
