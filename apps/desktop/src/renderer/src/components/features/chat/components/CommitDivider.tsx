import { useTranslation } from 'react-i18next';
import { CommitIcon } from '../../../common';

/**
 * Sawtooth "commit divider" shown at the bottom of the run timeline when the PR head has advanced past the commit the
 * most recent run reviewed (see ChatPane staleHeadSha). It marks the new head — signalling that the reviews above are
 * now based on stale code — even if no run has been started against the new commit yet. The label is the abbreviated
 * commit id (the full SHA is in the tooltip), reusing the same chip vocabulary as the single-commit scope badge in
 * RunResultView.
 */
export function CommitDivider({ sha }: { sha: string }) {
  const { t } = useTranslation();
  const short = sha.slice(0, 8);
  const title = t('chatPane.commitDividerTitle', { sha });
  return (
    <div className="chat-commit-divider" role="separator" aria-label={title}>
      <span className="chat-commit-divider__line" aria-hidden="true" />
      <span
        className="chat-chip chat-chip-quiet chat-chip-neutral chat-commit-divider__chip"
        title={title}
      >
        <CommitIcon size={12} />
        {short}
      </span>
      <span className="chat-commit-divider__line" aria-hidden="true" />
    </div>
  );
}
