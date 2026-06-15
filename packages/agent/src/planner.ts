import type { Rule } from '@meebox/rules';
import type { AgentStep, TokenUsage, ToolCatalogEntry } from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import { extractJson } from './orchestrator.js';
import { assertToolAllowed } from './tool-catalog.js';
import type { AgentContext } from './types.js';

/**
 * 自由规划（ReAct）编排器（见 docs/arch/06-agent.md「会话 Agent 化」）：交互式入口的自然
 * 语言请求由它处理——每步 chat 规划下一动作（调工具 / 收尾），解析 JSON 动作，红线硬校验后
 * 分发工具、把结果回喂，循环到 final 或步数上限。与固定微流程（runReviewMicroflow）互补。
 *
 * 纯逻辑：chat / runTool 注入；红线经 assertToolAllowed 落地（修改类未授权即拒、回喂让 LLM 改选）。
 */

export interface PlanningToolResult {
  text: string;
  usage?: TokenUsage;
}

export interface PlanningDeps {
  /** 规划 LLM 调用（单 system + user）。 */
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  /** 分发一个工具，返回文本结果（红线已由编排器先行校验）。 */
  runTool: (call: { tool: string; question?: string }) => Promise<PlanningToolResult>;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** 用户暂停信号；abort 后循环在下一步前停下，返回 terminationReason='用户暂停'。 */
  signal?: AbortSignal;
}

export interface PlanningInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  matchedRule?: Rule | null;
  language?: string;
  /** 用户的自然语言请求。 */
  userRequest: string;
  /** 步数上限（默认 8）。 */
  maxSteps?: number;
}

export interface PlanningResult {
  steps: AgentStep[];
  finalText: string;
  tokenUsage: TokenUsage;
  terminationReason?: string;
}

interface PlannerAction {
  thought?: string;
  tool?: string;
  question?: string;
  final?: string;
}

function addUsage(acc: TokenUsage, u?: TokenUsage): TokenUsage {
  if (!u) return acc;
  return {
    promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
    completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
    calls: (acc.calls ?? 0) + (u.calls ?? 1),
  };
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const PROTOCOL = [
  'Each turn, reply with JSON ONLY for the next action:',
  '- Use a tool: {"thought": "...", "tool": "/review", "question": "<only for /ask>"}',
  '- Finish:     {"thought": "...", "final": "<your answer to the user>"}',
  'Only call tools listed under "Available tools" that are NOT disabled. Prefer few precise steps.',
  'Routing policy:',
  '- If the request concerns this PR but no other tool clearly fits, default to /ask with a focused question.',
  '- If the request is unrelated to this PR, do NOT call any tool — briefly decline in "final".',
].join('\n');

export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};
  const history: string[] = [];

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRule: input.matchedRule,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${PROTOCOL}`;

  const record = async (step: AgentStep): Promise<void> => {
    steps.push(step);
    await deps.onStep?.(step);
  };

  for (let i = 0; i < maxSteps; i++) {
    if (deps.signal?.aborted) {
      return { steps, finalText: '', tokenUsage: usage, terminationReason: '用户暂停' };
    }

    const user = [
      `User request: ${input.userRequest}`,
      history.length ? `\nProgress so far:\n${history.join('\n')}` : '',
      '\nReply with the next JSON action.',
    ]
      .filter(Boolean)
      .join('\n');

    const r = await deps.chat({ system, user });
    usage = addUsage(usage, r.usage);
    const action = extractJson<PlannerAction>(r.text);

    // 无法解析 / 既无 tool 又无 final → 当作收尾（原文兜底）。
    if (!action || (!action.tool && !action.final)) {
      const finalText = action?.final ?? r.text.trim();
      await record({ kind: 'plan', thought: action?.thought, result: finalText });
      return { steps, finalText, tokenUsage: usage };
    }

    if (action.final && !action.tool) {
      await record({ kind: 'plan', thought: action.thought, result: action.final });
      return { steps, finalText: action.final, tokenUsage: usage };
    }

    const tool = action.tool ?? '';
    // 红线硬校验：修改类未授权 / 未知工具即拒，回喂让 LLM 改选（不崩流程）。
    try {
      assertToolAllowed(tool, input.toolCatalog);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await record({ kind: 'judge', thought: action.thought, toolCall: { tool }, result: `拒绝：${msg}` });
      history.push(`Refused ${tool}: ${msg}`);
      continue;
    }

    const res = await deps.runTool({ tool, question: action.question });
    usage = addUsage(usage, res.usage);
    await record({
      kind: 'tool',
      thought: action.thought,
      toolCall: { tool, args: action.question ? { question: action.question } : undefined },
      result: clamp(res.text, 400),
    });
    history.push(
      `Called ${tool}${action.question ? ` ("${action.question}")` : ''} → ${clamp(res.text, 600)}`,
    );
  }

  return { steps, finalText: '', tokenUsage: usage, terminationReason: '步数上限中止' };
}
