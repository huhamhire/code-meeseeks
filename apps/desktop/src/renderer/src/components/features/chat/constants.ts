export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;
/** 历史 run 的分页大小：进入 PR 默认展示最新 N 条，向上滚动到顶端再追加一批 */
export const RUNS_PAGE_SIZE = 10;

/** Agent 建议 verdict → i18n key（chatPane.agent.*）。 */
export const VERDICT_LABEL_KEY: Record<string, string> = {
  approve: 'chatPane.agent.verdictApprove',
  needs_work: 'chatPane.agent.verdictNeedsWork',
  manual_review: 'chatPane.agent.verdictManualReview',
};
