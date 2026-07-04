import type { LocalPrStatus, ReviewRunTool } from '@meebox/shared';
import { COMMANDS } from '../commands';

/**
 * Discriminated result of parsing the input-bar submission (pure function, no i18n / side effects):
 * - `unknown` —— starts with `/` but the command name is unknown (head used for the error hint)
 * - `commandNoArgs` —— a review-decision command was given extra arguments
 * - `askNeedsQuestion` —— `/ask` without a question
 * - `reviewAction` —— `/approve` `/needswork` → write reviewer status
 * - `mergeAction` —— `/merge` → merge the PR (input bar pops a confirm + canMerge gating)
 * - `run` —— pr-agent tool (review / describe / improve / ask)
 * - `agentAsk` —— no `/` prefix, natural-language "conversation as delegation" handed to the free-planning Agent
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
  // Parse the command head: starts with '/' → look it up in the COMMANDS table; no '/' → equivalent to natural-language delegation
  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const head = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const found = COMMANDS.find((c) => c.label === head);
    if (!found) return { kind: 'unknown', head };
    // review-action: /approve /needswork take no arguments; extra text is rejected to avoid misuse
    if (found.kind === 'review-action') {
      if (rest) return { kind: 'commandNoArgs', cmd: found.label };
      return { kind: 'reviewAction', status: found.reviewStatus };
    }
    // pr-action: /merge takes no arguments; canMerge gating and the confirmation are handled at the input-bar layer (useChatInput)
    if (found.kind === 'pr-action') {
      if (rest) return { kind: 'commandNoArgs', cmd: found.label };
      return { kind: 'mergeAction' };
    }
    // pragent: /ask must carry a question, other tools have an empty question
    if (found.name === 'ask') {
      if (!rest) return { kind: 'askNeedsQuestion' };
      return { kind: 'run', name: found.name, question: rest };
    }
    return { kind: 'run', name: found.name };
  }
  // No '/' → natural-language "conversation as delegation": handed to the free-planning Agent (not /ask).
  return { kind: 'agentAsk', question: trimmed };
}
