import type { AgentStep, TokenUsage } from '@meebox/shared';

/**
 * Agent 步骤抽象的共享基座（见 docs/arch/02-agent/01-agent.md）：把此前 planner（ReAct 循环）与 orchestrator
 * （评审微流程）各自重复的「记一步 + 累计用量」收口为可复用的 StepRecorder，并给出统一的 StepHandler
 * 形状——每条流程即一组按序执行的步骤（评审）或单步循环（规划），新流程 = 新的步骤组合，符合复用/扩展路线。
 */

/** 累加一笔 token 用量（容缺省；calls 缺省按 1 计）。各编排 / 步骤共用。 */
export function addUsage(acc: TokenUsage, u?: TokenUsage): TokenUsage {
  if (!u) return acc;
  return {
    promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
    completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
    calls: (acc.calls ?? 0) + (u.calls ?? 1),
  };
}

/**
 * 步骤记录器：收口「记一步」与「累计用量」。`record()` 给步骤补时间戳、入列并经 onStep 流式推送；
 * `track()` 累加用量；`steps` / `usage` 为累计读取。各流程驱动与步骤共享同一实例。
 */
export interface StepRecorder {
  readonly steps: AgentStep[];
  readonly usage: TokenUsage;
  record(step: AgentStep): Promise<void>;
  track(u?: TokenUsage): void;
}

export function createStepRecorder(onStep?: (step: AgentStep) => void | Promise<void>): StepRecorder {
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};
  return {
    steps,
    get usage(): TokenUsage {
      return usage;
    },
    record: async (step: AgentStep): Promise<void> => {
      const stamped = { ...step, at: step.at ?? new Date().toISOString() };
      steps.push(stamped);
      await onStep?.(stamped);
    },
    track: (u?: TokenUsage): void => {
      usage = addUsage(usage, u);
    },
  };
}

/**
 * 可插拔步骤的抽象基类：子类实现 `run(ctx)`，对给定运行上下文 `Ctx` 执行一段编排逻辑（记步、调工具 / LLM、
 * 写回累加器），返回 `R`。评审微流程是一组 `Step<Ctx>`（R=void）子类的有序「注册表」、顺序跑；规划是单个
 * `Step<Ctx, PlanCycleOutcome>` 子类、被驱动反复跑直至收尾。各子类无实例状态（运行态全在 ctx），故以
 * 单例入注册表。`name` 便于调试 / 注册表可读。
 */
export abstract class Step<Ctx, R = void> {
  abstract readonly name: string;
  abstract run(ctx: Ctx): Promise<R>;
}
