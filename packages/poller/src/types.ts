// Reuse the contract types from shared (the renderer also sees them via IPC).
export type { LocalPrStatus, PollResult, StoredPullRequest } from '@meebox/shared';

// PR state schema (index + meta) now lives in pr-state.ts, re-exported from there
