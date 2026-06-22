import type { TokenUsage } from '@meebox/shared';
import { DESC_CLAMP } from './constants.js';
import { PROMPT_TEMPLATES } from './prompts.js';
import { isValidReviewPlan, type ReviewPlan, type ReviewStepKind } from './steps/review/index.js';
import { extractJson, fillTemplate } from './utils/index.js';

/** 解析 judge 给出的步骤计划：非数组 / 含非法 kind / 缺前置 describe-review → undefined（回落默认全集）。 */
function parseReviewPlan(raw: unknown): ReviewPlan | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps = raw.filter((s): s is ReviewStepKind => typeof s === 'string') as ReviewStepKind[];
  const plan: ReviewPlan = { steps };
  return isValidReviewPlan(plan) ? plan : undefined;
}

/**
 * AutoPilot 批量判定（见 docs/arch/06-agent.md「AutoPilot」的例外规则）：把一批候选 PR 的
 * 标题 + 描述喂给 LLM，逐 PR 判「是否值得自动评审」并附原因（例如分支合并 / 回合并类、
 * 纯依赖升级可跳过）。纯逻辑：LLM 通道注入，可单测。
 */

export interface JudgeCandidate {
  prLocalId: string;
  title: string;
  description?: string;
  /** 源 / 目标分支名（背景输入，助判分支合并 / 回合并）。 */
  sourceBranch?: string;
  targetBranch?: string;
  /** 调用方据元数据判出的「纯分支合并」信号（见 classifyBranchMerge）；true 时强烈倾向 skip。 */
  branchMerge?: boolean;
}

export interface JudgeDecision {
  prLocalId: string;
  review: boolean;
  reason: string;
  /**
   * 该 PR 的评审执行计划（步骤序列）。本期判定**不产出**（恒省略 → 走 DEFAULT_REVIEW_PLAN）；预留为后续
   * 「规则驱动步骤选择」的注入点：judge 提示词 + AGENTS.md 规则可逐 PR 给出计划（跳过 / 重排 / 增删步骤）。
   */
  plan?: ReviewPlan;
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
    .map((c, i) => {
      const branch =
        c.sourceBranch && c.targetBranch
          ? `\nbranches: ${c.sourceBranch} -> ${c.targetBranch}${c.branchMerge ? '  [detected branch merge — prefer skip]' : ''}`
          : '';
      return `${String(i + 1)}. [id:${c.prLocalId}] ${c.title}${branch}\n${(c.description ?? '').trim().slice(0, DESC_CLAMP)}`;
    })
    .join('\n\n');

  const user = [
    'For each PR decide review (true) or skip (false) with a short reason; optionally add a custom step "plan" (see system).',
    'Reply with JSON only: {"decisions": [{"prLocalId": string, "review": boolean, "reason": string, "plan"?: string[]}]}.',
    '',
    list,
  ].join('\n');

  const r = await chat({ system, user });
  const parsed = extractJson<{
    decisions?: Array<{ prLocalId?: unknown; review?: unknown; reason?: unknown; plan?: unknown }>;
  }>(r.text);

  const byId = new Map<string, JudgeDecision>();
  for (const d of parsed?.decisions ?? []) {
    if (typeof d.prLocalId === 'string') {
      // plan 非法 / 省略 → undefined（评审走默认全集）；合法才带上，由 autopilot 透传给微流程。
      const plan = parseReviewPlan(d.plan);
      byId.set(d.prLocalId, {
        prLocalId: d.prLocalId,
        // 缺省 / 非显式 false → 评审（保守：宁可多评不漏）
        review: d.review !== false,
        reason: typeof d.reason === 'string' ? d.reason : '',
        ...(plan ? { plan } : {}),
      });
    }
  }

  // 解析缺失的候选默认评审，保证每个候选都有决策。
  const decisions = input.candidates.map(
    (c) =>
      byId.get(c.prLocalId) ?? {
        prLocalId: c.prLocalId,
        review: true,
        reason: 'default (unparsed)',
      },
  );
  return { decisions, usage: r.usage };
}
