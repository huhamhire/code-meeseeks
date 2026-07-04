import type { LocalPrStatus, ReviewRunTool } from '@meebox/shared';

/** Slot definitions: keyboard actions / command buttons / autocomplete menu all draw from here */
/**
 * Chat commands fall into three kinds:
 *  - 'pragent': pr-agent tools (review / describe / ask), trigger pragent:run
 *  - 'review-action': PR review verdicts (approve / needswork), write Bitbucket reviewer status
 *    triggered via prs:setLocalStatus, sharing the same path as the PR header buttons
 *  - 'pr-action': PR remote actions (merge), trigger prs:merge, sharing the same path as the PR header merge button;
 *    only available when mergeStatus.canMerge, the input bar shows a confirm dialog
 */
export type CommandSpec =
  | {
      kind: 'pragent';
      name: ReviewRunTool;
      label: string;
      /** i18n key (chatPane namespace) resolving the command description, rendered via t(descKey) */
      descKey: string;
      insertAs: string;
    }
  | {
      kind: 'review-action';
      name: 'approve' | 'needswork';
      label: string;
      /** i18n key (chatPane namespace) resolving the command description, rendered via t(descKey) */
      descKey: string;
      insertAs: string;
      reviewStatus: LocalPrStatus;
    }
  | {
      kind: 'pr-action';
      name: 'merge';
      label: string;
      /** i18n key (chatPane namespace) resolving the command description, rendered via t(descKey) */
      descKey: string;
      insertAs: string;
    };

// Group order: pr-agent tools → separator → review verdicts
export const COMMANDS: ReadonlyArray<CommandSpec> = [
  // pr-agent
  {
    kind: 'pragent',
    name: 'review',
    label: '/review',
    descKey: 'chatPane.cmdReviewDesc',
    insertAs: '/review',
  },
  {
    kind: 'pragent',
    name: 'describe',
    label: '/describe',
    descKey: 'chatPane.cmdDescribeDesc',
    insertAs: '/describe',
  },
  // /improve: after the shim forces gfm_markdown=True, improve takes the "summarized suggestions → publish_comment →
  // review.md" path (non-committable, inline mode still unavailable), and parse-output parses findings with importance scores
  // per the <details> template of generate_summarized_suggestions.
  {
    kind: 'pragent',
    name: 'improve',
    label: '/improve',
    descKey: 'chatPane.cmdImproveDesc',
    insertAs: '/improve',
  },
  {
    kind: 'pragent',
    name: 'ask',
    label: '/ask',
    descKey: 'chatPane.cmdAskDesc',
    insertAs: '/ask ',
  },
  // review verdicts (share prs:setLocalStatus with the PR header buttons, write Bitbucket reviewer status)
  {
    kind: 'review-action',
    name: 'approve',
    label: '/approve',
    descKey: 'chatPane.cmdApproveDesc',
    insertAs: '/approve',
    reviewStatus: 'approved',
  },
  {
    kind: 'review-action',
    name: 'needswork',
    label: '/needswork',
    descKey: 'chatPane.cmdNeedsworkDesc',
    insertAs: '/needswork',
    reviewStatus: 'needs_work',
  },
  // PR remote action: merge (shares prs:merge with the PR header merge button). Visible in the input bar only when canMerge, shows a confirm dialog.
  {
    kind: 'pr-action',
    name: 'merge',
    label: '/merge',
    descKey: 'chatPane.cmdMergeDesc',
    insertAs: '/merge',
  },
];
