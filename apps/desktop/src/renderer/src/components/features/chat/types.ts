import type { IpcChannels } from '@meebox/ipc';

/** 当前 PR 命中的全部规则（针对 /review 工具）；空数组 = 未配置 / 无命中。 */
export type MatchedRules = IpcChannels['rules:matchForPr']['response'];
/** 单条命中规则。 */
export type MatchedRule = MatchedRules[number];
