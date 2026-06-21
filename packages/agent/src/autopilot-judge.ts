import type { TokenUsage } from '@meebox/shared';
import { DESC_CLAMP } from './constants.js';
import { PROMPT_TEMPLATES } from './prompts.js';
import { extractJson, fillTemplate } from './utils/index.js';

/**
 * AutoPilot 批量判定（见 docs/arch/06-agent.md「AutoPilot」的例外规则）：把一批候选 PR 的
 * 标题 + 描述喂给 LLM，逐 PR 判「是否值得自动评审」并附原因（例如分支合并 / 回合并类、
 * 纯依赖升级可跳过）。纯逻辑：LLM 通道注入，可单测。
 */

export interface JudgeCandidate {
  prLocalId: string;
  title: string;
  description?: string;
}

export interface JudgeDecision {
  prLocalId: string;
  review: boolean;
  reason: string;
}

export interface AutopilotJudgeInput {
  candidates: JudgeCandidate[];
  /** AGENTS.md 正文：例外规则来源（可在其中扩充跳过条件）。 */
  agentsRules?: string;
}

export interface AutopilotJudgeResult {
  decisions: JudgeDecision[];
  usage?: TokenUsage;
}

export async function judgeAutopilotBatch(
  chat: (input: { system: string; user: string }) => Promise<{ text: string; usage?: TokenUsage }>,
  input: AutopilotJudgeInput,
): Promise<AutopilotJudgeResult> {
  if (input.candidates.length === 0) return { decisions: [] };

  // 判定 system 基底外置在 resources/prompts/autopilot-judge.md；项目规则（AGENTS.md 正文）按需追加。
  const system = [
    fillTemplate(PROMPT_TEMPLATES.autopilotJudge, {}),
    input.agentsRules?.trim()
      ? `\nProject rules (may add skip exceptions):\n${input.agentsRules.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const list = input.candidates
    .map(
      (c, i) =>
        `${String(i + 1)}. [id:${c.prLocalId}] ${c.title}\n${(c.description ?? '').trim().slice(0, DESC_CLAMP)}`,
    )
    .join('\n\n');

  const user = [
    'For each PR decide review (true) or skip (false) with a short reason.',
    'Reply with JSON only: {"decisions": [{"prLocalId": string, "review": boolean, "reason": string}]}.',
    '',
    list,
  ].join('\n');

  const r = await chat({ system, user });
  const parsed = extractJson<{
    decisions?: Array<{ prLocalId?: unknown; review?: unknown; reason?: unknown }>;
  }>(r.text);

  const byId = new Map<string, JudgeDecision>();
  for (const d of parsed?.decisions ?? []) {
    if (typeof d.prLocalId === 'string') {
      byId.set(d.prLocalId, {
        prLocalId: d.prLocalId,
        // 缺省 / 非显式 false → 评审（保守：宁可多评不漏）
        review: d.review !== false,
        reason: typeof d.reason === 'string' ? d.reason : '',
      });
    }
  }

  // 解析缺失的候选默认评审，保证每个候选都有决策。
  const decisions = input.candidates.map(
    (c) => byId.get(c.prLocalId) ?? { prLocalId: c.prLocalId, review: true, reason: 'default (unparsed)' },
  );
  return { decisions, usage: r.usage };
}
