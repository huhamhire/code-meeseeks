import type { IpcChannels } from '@meebox/ipc';

/** 当前 PR 命中的规则（针对 /review 工具）；null = 未配置 / 无命中。 */
export type MatchedRule = IpcChannels['rules:matchForPr']['response'];
