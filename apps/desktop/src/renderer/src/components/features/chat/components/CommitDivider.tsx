import { CommitIcon } from '../../../common';

/** Marks a source-head transition in the review timeline. */
export function CommitDivider({ sha, message }: { sha: string; message?: string }) {
  const short = sha.slice(0, 8);
  // Tooltip = the actual commit message (more meaningful than a generic "code changed" string, and needs no i18n).
  const title = message?.trim() || short;
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

export function CommitDividerList({
  shas = [],
  messages,
}: {
  shas?: readonly string[];
  messages?: ReadonlyMap<string, string>;
}) {
  return shas.map((sha, index) => (
    <CommitDivider key={`${sha}-${String(index)}`} sha={sha} message={messages?.get(sha)} />
  ));
}
