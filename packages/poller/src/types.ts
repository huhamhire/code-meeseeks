// 复用 shared 中的契约类型（renderer 也会经 IPC 看到）。
export type { LocalPrStatus, PollResult, StoredPullRequest } from '@pr-pilot/shared';

// PR state schema (索引 + meta) 现位于 pr-state.ts，从那里 re-export
