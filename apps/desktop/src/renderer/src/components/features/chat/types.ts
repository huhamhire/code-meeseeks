import type { IpcChannels } from '@meebox/ipc';

/** All rules matched by the current PR (for the /review tool); empty array = unconfigured / no match. */
export type MatchedRules = IpcChannels['rules:matchForPr']['response'];
/** A single matched rule. */
export type MatchedRule = MatchedRules[number];
