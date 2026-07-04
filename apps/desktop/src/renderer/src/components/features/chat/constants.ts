export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;
/** Page size for history runs: on entering a PR, show the latest N by default, then append another batch when scrolling to the top */
export const RUNS_PAGE_SIZE = 10;

/** Agent suggestion verdict → i18n key (chatPane.agent.*). */
export const VERDICT_LABEL_KEY: Record<string, string> = {
  approve: 'chatPane.agent.verdictApprove',
  needs_work: 'chatPane.agent.verdictNeedsWork',
  manual_review: 'chatPane.agent.verdictManualReview',
};
