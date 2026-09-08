import { useSyncExternalStore } from 'react';

/**
 * The comment currently referenced into the Agent conversation ("ask the agent about this comment").
 *
 * A reviewer's comment is often a question — is this actually a problem, does this path really run, was this handled
 * elsewhere — and answering it means reading the code the comment is attached to. That is what the Agent is for, but
 * until now the only way to hand it a comment was to copy the text into the chat box, losing the anchor and the thread
 * along with it.
 *
 * Lives in a module-level store for the same reason the diff selection does: the comment surfaces (activity panel,
 * inline diff zone) and ChatPane are sibling panes with no common owner below App, and the reference has to survive
 * the panes re-rendering independently. Same shape as selection-store (module state + subscriber set +
 * useSyncExternalStore), purely renderer-local, no IPC and nothing persisted — a reference is a transient intent.
 */
export interface CommentReference {
  /** PR the reference belongs to; a reference from another PR is never presented (see useCommentReference). */
  prLocalId: string;
  /** Remote comment id, so the prompt can name the comment the answer is about. */
  commentId: string;
  /** Display name of the comment's author. */
  author: string;
  /** Comment body as written (markdown, unrendered). */
  body: string;
  /** Inline comments carry their code location; a summary comment has none. */
  anchor?: { path: string; line?: number | null };
}

interface CommentReferenceState {
  reference: CommentReference | null;
}

let state: CommentReferenceState = { reference: null };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

export const commentReferenceStore = {
  getSnapshot: (): CommentReferenceState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  /** Reference a comment (replaces any current one — the input bar carries at most one comment reference). */
  set: (reference: CommentReference): void => {
    state = { reference };
    notify();
  },
  clear: (): void => {
    if (!state.reference) return;
    state = { reference: null };
    notify();
  },
};

/** The reference for this PR, or null (including when the stored one belongs to another PR). */
export function useCommentReference(prLocalId: string | undefined): CommentReference | null {
  const snap = useSyncExternalStore(
    commentReferenceStore.subscribe,
    commentReferenceStore.getSnapshot,
  );
  const ref = snap.reference;
  return ref && ref.prLocalId === prLocalId ? ref : null;
}

/** Trim a body for chip / prompt display, on a word boundary where there is one nearby. */
function excerpt(body: string, max: number): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Short label for the input-bar chip: the author plus enough of the comment to tell which one it is. */
export function commentReferenceLabel(ref: CommentReference): string {
  return `${ref.author}: ${excerpt(ref.body, 40)}`;
}

/**
 * Assemble the referenced comment into a self-describing block, sent as implicit context alongside the question (the
 * same channel the diff selection uses, so the two compose when both are present).
 *
 * States what the agent is being asked to do, because a comment alone is ambiguous input: without it a model tends to
 * summarize the comment back rather than investigate the claim. Four-backtick fences, since a comment body can easily
 * contain triple backticks of its own.
 */
export function formatCommentReference(ref: CommentReference): string {
  const where = ref.anchor
    ? ` on \`${ref.anchor.path}\`${ref.anchor.line ? `:${String(ref.anchor.line)}` : ''}`
    : '';
  return [
    `The user is asking about this review comment${where}, written by ${ref.author}:`,
    '',
    '````',
    ref.body,
    '````',
    '',
    'Investigate what it claims against the actual code and say whether it holds, with the evidence you found.',
  ].join('\n');
}
