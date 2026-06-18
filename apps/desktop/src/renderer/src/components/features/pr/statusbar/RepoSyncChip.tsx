import { useTranslation } from 'react-i18next';
import { useRepoSyncStore } from '../../../../stores/repo-sync-store';
import { StatusChip } from '../../../common/StatusChip';

/**
 * Repo sync 活动 chip：显示当前正在 clone/fetch 的 repo + 阶段 + 百分比。
 * 队列里只有一条在跑 (RepoMirrorManager 全局单队列)；store 收着多条时只展示首条。
 * idle 不渲染，避免占状态栏宽度。
 */
export function RepoSyncChip() {
  const { t } = useTranslation();
  const { active } = useRepoSyncStore();
  if (active.size === 0) return null;
  // Map 没保证迭代序，但 sync 同时只跑一个，多于一个时按 startedAt 升序选最早的
  const snapshots = Array.from(active.values()).sort((a, b) => a.startedAt - b.startedAt);
  const cur = snapshots[0]!;
  const more = snapshots.length - 1;
  // repo = "host/projectKey/repoSlug"，UI 紧凑只展示最后一段
  const shortRepo = cur.repo.split('/').slice(-1)[0] ?? cur.repo;
  const stageLabel = cur.stage ? `${cur.stage}` : t('statusBar.syncing');
  const pct = typeof cur.percent === 'number' ? ` ${String(Math.round(cur.percent))}%` : '';
  const queueSuffix = more > 0 ? ` (+${String(more)})` : '';
  return (
    <StatusChip
      className="statusbar-repo-sync-chip"
      title={`${cur.repo} · ${stageLabel}${pct}${cur.message ? `\n${cur.message}` : ''}`}
    >
      <span className="statusbar-pragent-dot" aria-hidden="true" />
      <span className="statusbar-repo-sync-name">{shortRepo}</span>
      <span className="statusbar-repo-sync-progress muted">
        {stageLabel}
        {pct}
        {queueSuffix}
      </span>
    </StatusChip>
  );
}
