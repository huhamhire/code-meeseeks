import { useTranslation } from 'react-i18next';
import { useRepoSyncStore } from '../../../../stores/repo-sync-store';
import { StatusChip } from '../../../common';

/**
 * Repo sync activity chip: shows the repo currently being cloned/fetched + stage + percentage.
 * Only one runs in the queue at a time (RepoMirrorManager global single queue); when the store holds multiple, only the first is shown.
 * Not rendered when idle, to avoid taking up status bar width.
 */
export function RepoSyncChip() {
  const { t } = useTranslation();
  const { active } = useRepoSyncStore();
  if (active.size === 0) return null;
  // Map doesn't guarantee iteration order, but only one sync runs at a time; when there's more than one, pick the earliest by startedAt ascending
  const snapshots = Array.from(active.values()).sort((a, b) => a.startedAt - b.startedAt);
  const cur = snapshots[0]!;
  const more = snapshots.length - 1;
  // repo = "host/projectKey/repoSlug"; for a compact UI show only the last segment
  const shortRepo = cur.repo.split('/').slice(-1)[0] ?? cur.repo;
  const stageLabel = cur.stage ? `${cur.stage}` : t('statusBar.syncing');
  const pct = typeof cur.percent === 'number' ? ` ${String(Math.round(cur.percent))}%` : '';
  const queueSuffix = more > 0 ? ` (+${String(more)})` : '';
  return (
    <StatusChip
      className="statusbar-repo-sync-chip"
      title={`${cur.repo} · ${stageLabel}${pct}${cur.message ? `\n${cur.message}` : ''}`}
    >
      <span className="activity-dot" aria-hidden="true" />
      <span className="statusbar-repo-sync-name">{shortRepo}</span>
      <span className="statusbar-repo-sync-progress muted">
        {stageLabel}
        {pct}
        {queueSuffix}
      </span>
    </StatusChip>
  );
}
