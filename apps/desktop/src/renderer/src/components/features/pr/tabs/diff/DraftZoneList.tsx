import { useTranslation } from 'react-i18next';
import type { PlatformKind, PlatformUser, ReviewDraft } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { formatBackendError } from '../../../../../errors';
import { DraftZone } from '../drafts/DraftZone';

/**
 * Container for multiple drafts on the same line; each is an independent DraftZone (maintaining its own read/edit), separated by hr.
 * onSave / onDelete call IPC drafts:update / drafts:delete here; after writing to disk the main side
 * broadcasts a drafts:changed event → drafts-store refetches → DiffView's top-level useEffect rebuilds the
 * zones (this component unmounts/remounts along with it).
 */
export function DraftZoneList({
  drafts,
  prLocalId,
  registerEditTrigger,
  hardBreaks,
  attachmentsEnabled = false,
  mentionCandidates,
  platform,
}: {
  drafts: ReviewDraft[];
  prLocalId: string;
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  hardBreaks: boolean;
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); passed through to the draft editor to enable paste / pick upload. */
  attachmentsEnabled?: boolean;
  /** `@mention` autocomplete candidates for the draft editor (bounded PR participants; see collectMentionCandidates). */
  mentionCandidates?: PlatformUser[];
  /** Active platform, deciding inserted mention syntax (Bitbucket quotes non-simple usernames). */
  platform?: PlatformKind;
}) {
  const { t } = useTranslation();
  const onSave = async (draftId: string, body: string): Promise<void> => {
    await invoke('drafts:update', {
      localId: prLocalId,
      draftId,
      patch: { body },
    });
  };
  const onDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: prLocalId, draftId });
  };
  // Single publish: reuse the drafts:publishBatch handler, passing a single-element [draftId]. This shares the same
  // main-side logic with PublishReviewModal's batch path (anchor mapping / posted
  // write-back / force-refresh comments / failure collection are all consistent), keeping behavior predictable so a future
  // change to either doesn't fork the two paths
  const onPublish = async (draftId: string): Promise<{ ok: boolean; error?: string }> => {
    const resp = await invoke('drafts:publishBatch', {
      localId: prLocalId,
      draftIds: [draftId],
    });
    const r = resp.results[0];
    if (!r) return { ok: false, error: t('diffView.noResultFromMain') };
    // r.error is an AppError encoded string (draft-domain EPR* / publish exception), decoded here into localized text before being handed up for display.
    return { ok: r.ok, error: r.error ? formatBackendError(r.error).title : undefined };
  };
  return (
    <div className="draft-zone-list">
      {drafts.map((d, i) => (
        <div key={d.id} className={`draft-zone-item${i > 0 ? ' draft-zone-item-divider' : ''}`}>
          <DraftZone
            draft={d}
            prLocalId={prLocalId}
            attachmentsEnabled={attachmentsEnabled}
            hardBreaks={hardBreaks}
            mentionCandidates={mentionCandidates}
            platform={platform}
            registerEditTrigger={registerEditTrigger}
            onSave={(body) => onSave(d.id, body)}
            onDelete={() => onDelete(d.id)}
            onPublish={() => onPublish(d.id)}
          />
        </div>
      ))}
    </div>
  );
}
