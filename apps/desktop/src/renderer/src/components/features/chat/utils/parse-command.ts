import type { LocalPrStatus, ReviewRunTool } from '@meebox/shared';
import { COMMANDS } from '../commands';

/**
 * 解析输入栏提交内容的判别式结果（纯函数，不做 i18n / 副作用）：
 * - `unknown` —— `/` 起手但命令名未知（head 用于错误提示）
 * - `commandNoArgs` —— review 决断命令带了多余参数
 * - `askNeedsQuestion` —— `/ask` 未带问题
 * - `reviewAction` —— `/approve` `/needswork` → 写 reviewer status
 * - `mergeAction` —— `/merge` → 合并 PR（输入栏弹确认 + canMerge 门控）
 * - `run` —— pr-agent 工具（review / describe / improve / ask）
 * - `agentAsk` —— 无 `/` 前缀，自然语言「对话即委派」交给自由规划 Agent
 */
export type ParsedCommand =
  | { kind: 'unknown'; head: string }
  | { kind: 'commandNoArgs'; cmd: string }
  | { kind: 'askNeedsQuestion' }
  | { kind: 'reviewAction'; status: LocalPrStatus }
  | { kind: 'mergeAction' }
  | { kind: 'run'; name: ReviewRunTool; question?: string }
  | { kind: 'agentAsk'; question: string };

export function parseChatCommand(trimmed: string): ParsedCommand {
  // 解析命令头：'/' 起手 → COMMANDS 表里找；无 '/' → 等价自然语言委派
  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const head = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const found = COMMANDS.find((c) => c.label === head);
    if (!found) return { kind: 'unknown', head };
    // review-action：/approve /needswork 没有参数，多余文本拒绝以免误用
    if (found.kind === 'review-action') {
      if (rest) return { kind: 'commandNoArgs', cmd: found.label };
      return { kind: 'reviewAction', status: found.reviewStatus };
    }
    // pr-action：/merge 无参数；canMerge 门控与二次确认在输入栏层（useChatInput）处理
    if (found.kind === 'pr-action') {
      if (rest) return { kind: 'commandNoArgs', cmd: found.label };
      return { kind: 'mergeAction' };
    }
    // pragent：/ask 必须带问题，其他工具空 question
    if (found.name === 'ask') {
      if (!rest) return { kind: 'askNeedsQuestion' };
      return { kind: 'run', name: found.name, question: rest };
    }
    return { kind: 'run', name: found.name };
  }
  // 无 '/' → 自然语言「对话即委派」：交给自由规划 Agent（而非 /ask）。
  return { kind: 'agentAsk', question: trimmed };
}
