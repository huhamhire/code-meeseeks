import { MAX_PARALLEL_TOOLS } from '../../constants.js';
import { extractJson, salvageProse, stripTrailingJson } from '../../orchestrator.js';
import { runStaggered } from '../../stagger.js';
import { assertToolAllowed } from '../../tool-catalog.js';
import { Step } from '../context.js';
import {
  accumulateRemember,
  clamp,
  normalizePlan,
  parseRecommendation,
  type PlanCycleOutcome,
  type PlanStepCtx,
  type PlannerAction,
} from './shared.js';

/**
 * 自由规划（ReAct）的「单步」：拼当轮 prompt → chat → 解析动作 → 红线硬校验 → 并行派发工具 / 收尾。abort 在
 * 思考前后各检一次（思考阶段也能即时停）；中途输入并入 progress、计划随轮维护与重排。驱动（planner）反复跑
 * 本步直至 final / 步数上限。无实例状态（运行态全在 ctx），以单例 planCycleStep 入驱动。
 */
export class PlanCycleStep extends Step<PlanStepCtx, PlanCycleOutcome> {
  readonly name = 'plan-cycle';

  async run(ctx: PlanStepCtx): Promise<PlanCycleOutcome> {
    const { deps, input, rec, system, convo, labels, history, memories } = ctx;
    if (deps.signal?.aborted) return { kind: 'aborted' };

    // 中途输入转向：把运行期间排队的用户新消息并入 progress，让本轮 ReAct 据「最新指令 + 当前进度」重排
    // 下一步。消息已由实现方在取出时持久化进会话，此处只注入提示、不再落盘。
    const pending = (await deps.drainPendingInput?.()) ?? [];
    for (const m of pending) {
      history.push(`New user message (latest instruction — reconcile with the plan and progress): ${m}`);
    }

    const user = [
      convo
        ? `Conversation so far (your context only — NEVER pass any of it to tools):\n${convo}\n`
        : '',
      `User request: ${input.userRequest}`,
      input.referencedContext
        ? `\nReferenced selection (your context only — NEVER pass any of it to tools):\n${input.referencedContext}`
        : '',
      ctx.plan.length
        ? `\nCurrent plan (keep it updated — mark items done, reorder by priority, add/remove as the task or new user messages change):\n${ctx.plan.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}`
        : '',
      history.length ? `\nProgress so far:\n${history.join('\n')}` : '',
      '\nReply with the next JSON action.',
    ]
      .filter(Boolean)
      .join('\n');

    // 计本轮 LLM 推理耗时（单步思考时长，类 Claude Code 的「Thought for Ns」），系到该决策步上。
    const thinkStart = Date.now();
    const r = await deps.chat({ system, user });
    const thinkMs = Date.now() - thinkStart;
    // 思考刚结束就发现已被停止 → 立即收尾，不再据此动作分发工具（停止在思考阶段也即时生效）。
    if (deps.signal?.aborted) return { kind: 'aborted' };
    rec.track(r.usage);
    const action = extractJson<PlannerAction>(r.text);
    // 累加本动作携带的记忆（任何动作都可附 remember）。
    accumulateRemember(action?.remember, memories);
    // 计划更新：模型给出 plan 即归一、更新当前计划并持久化 + 广播（省略 plan = 沿用上一轮）。
    if (action?.plan !== undefined) {
      ctx.plan = normalizePlan(action.plan);
      await deps.recordPlan?.(ctx.plan);
    }

    const hasCalls = Boolean(action?.tool) || Boolean(action?.tools?.length);

    // 无法解析 / 既无 tool(s) 又无 final → 当作收尾。兜底从原始文本打捞散文，绝不把原始 JSON 动作丢给用户。
    if (!action || (!hasCalls && !action.final)) {
      const finalText = action?.final ?? salvageProse(r.text);
      await rec.record({ kind: 'plan', thought: action?.thought, result: finalText, thinkMs, usage: r.usage });
      return { kind: 'final', finalText };
    }

    if (action.final && !hasCalls) {
      // 剥掉模型误并入 final 末尾的判定 JSON（recommendation 走独立字段渲染为判定徽标）。
      const finalText = stripTrailingJson(action.final);
      await rec.record({ kind: 'plan', thought: action.thought, result: finalText, thinkMs, usage: r.usage });
      return { kind: 'final', finalText, recommendation: parseRecommendation(action.recommendation) };
    }

    // 归一为待执行工具列表：tools 多选（并行、只读）优先——元素可为工具名或 {tool, question}（多个
    // 带问题的 /ask 也能一轮并行派发）；否则单 tool（可带 question）。
    const requested: Array<{ tool: string; question?: string }> = action.tools?.length
      ? action.tools
          .slice(0, MAX_PARALLEL_TOOLS)
          .map((tl) => (typeof tl === 'string' ? { tool: tl } : { tool: tl.tool ?? '', question: tl.question }))
      : [{ tool: action.tool ?? '', question: action.question }];

    // 红线硬校验逐个把关：未授权 / 未知即拒并回喂；允许的留待并行执行。
    const allowed: Array<{ tool: string; question?: string }> = [];
    for (const c of requested) {
      try {
        assertToolAllowed(c.tool, input.toolCatalog);
        allowed.push(c);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await rec.record({
          kind: 'judge',
          thought: action.thought,
          toolCall: { tool: c.tool },
          result: `${labels.rejectedPrefix}${msg}`,
        });
        history.push(`Refused ${c.tool}: ${msg}`);
      }
    }
    if (!allowed.length) return { kind: 'continue' }; // 全被拒 → 回喂后下一轮重选

    // 类 Claude Code：先把本轮思考与所选步骤作为一步流式出去（思考是工具选择的前因），随后才执行工具。
    // 工具执行的进度 / 计时由 run 卡片承载，这里不再为每个工具补记 tool 步，避免决策被堆到结果之后。
    await rec.record({
      kind: 'plan',
      thought: action.thought,
      toolCall: { tool: allowed.map((c) => c.tool).join(' + ') },
      thinkMs,
      usage: r.usage,
    });

    // 并行分发允许的工具（多选时同时跑，实际并发受运行队列约束）；相互错开 100~200ms 起跑，避免同一瞬间齐发。
    const ran = await runStaggered(allowed, async (c) => ({ c, res: await deps.runTool(c) }));
    for (const { c, res } of ran) {
      rec.track(res.usage);
      history.push(`Called ${c.tool}${c.question ? ` ("${c.question}")` : ''} → ${clamp(res.text, 600)}`);
    }
    return { kind: 'continue' };
  }
}

/** 规划单步循环的单例（无实例状态）；驱动反复 `planCycleStep.run(ctx)`。 */
export const planCycleStep = new PlanCycleStep();
