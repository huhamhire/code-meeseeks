import { useMemo } from 'react';
import type { PragentRunInfo } from '@meebox/ipc';
import type { AgentMessage, AgentStep, ReviewRun } from '@meebox/shared';

/** 时间线一项：四类内容（run 卡片 / 运行中 run / 思考步骤 / 对话消息）按启动时间归并后的承载体。 */
export interface TimelineEntry {
  key: string;
  sortTime: number;
  run: ReviewRun | null;
  active: PragentRunInfo | null;
  step: AgentStep | null;
  message: AgentMessage | null;
}

function ms(iso: string | null | undefined): number {
  const n = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * 用户直接发起的斜杠命令的回显文案：/ask 显示问题正文（更贴近对话；空问题回退 `/ask`），
 * describe/review/improve 显示 `/工具名`。仅用于命令回显气泡，不做 i18n（就是用户键入的命令）。
 */
function echoContent(tool: string, question: string | undefined): string {
  if (tool === 'ask') {
    const q = question?.trim();
    if (q) return q;
  }
  return `/${tool}`;
}

/**
 * 历史时间线 + 实时「思考中」计时锚点。
 *
 * timeline：把已完成 run、正在执行的 run、Agent 思考步骤、对话消息统一按**启动时间**归并排序，
 * 顺序固定——即便后启动的任务先完成，也排在先启动（仍在执行）的任务下方，不因完成先后跳序。
 * 类 Claude Code「先思考→定步骤→执行步骤」：思考步骤（plan/judge）是工具选择的前因，排在所选工具的
 * run 卡片之前；工具执行的进度 / 计时由 run 卡片承载，不重复。排队中（未启动）的任务不入此列，另置末尾。
 *
 * thinkingSince：「思考中」实时计时的锚点，取「最近一次活动结束」——{本 PR run 起点, 末个思考步 at,
 * 末个完成 run 的结束时刻} 三者最晚者。锚到持久数据（runningPrs 跨 PR 切换不清、run 历史会重载）而非
 * 组件挂载，故切走再切回不清零；用 run 结束而非步骤记录时刻，避免把工具执行时间算进当前思考。
 */
export function useChatTimeline(params: {
  visibleRuns: ReviewRun[];
  myActiveRuns: ReadonlyArray<PragentRunInfo>;
  agentSteps: AgentStep[];
  messages: AgentMessage[];
  runningPrs: Map<string, number>;
  prLocalId: string | undefined;
}): { timeline: TimelineEntry[]; thinkingSince: number } {
  const { visibleRuns, myActiveRuns, agentSteps, messages, runningPrs, prLocalId } = params;

  const timeline = useMemo<TimelineEntry[]>(() => {
    const base = {
      run: null as ReviewRun | null,
      active: null as PragentRunInfo | null,
      step: null as AgentStep | null,
      message: null as AgentMessage | null,
    };
    const runEntries = visibleRuns.map((r) => ({
      ...base,
      key: `run-${r.id}`,
      sortTime: ms(r.startedAt),
      run: r as ReviewRun | null,
    }));
    const activeEntries = myActiveRuns.map((a) => ({
      ...base,
      key: `active-${a.runId}`,
      sortTime: ms(a.startedAt ?? a.enqueuedAt),
      active: a as PragentRunInfo | null,
    }));
    const stepEntries = agentSteps.map((s, i) => ({
      ...base,
      key: `step-${i}-${s.at ?? ''}`,
      sortTime: ms(s.at),
      step: s as AgentStep | null,
    }));
    const msgEntries = messages.map((m, i) => ({
      ...base,
      key: `msg-${i}-${m.at}`,
      sortTime: ms(m.at),
      message: m as AgentMessage | null,
    }));
    // 命令回显气泡：仅对**用户直接发起**（origin==='user'）的 run 补一条 user 消息，紧贴其卡片之上
    // （sortTime 取起跑时刻 -1ms）。编排 / AutoPilot 子 run（origin==='agent'）不回显——其用户输入已由
    // 编排会话的用户消息承载。历史 run 无 origin（undefined）→ 不回显。active 与完成态同一 runId 互斥，
    // key 统一为 `echo-<runId>`，运行中→完成的切换平滑不重挂。
    const echoOf = (
      runId: string,
      tool: string,
      question: string | undefined,
      anchorMs: number,
    ) => ({
      ...base,
      key: `echo-${runId}`,
      sortTime: anchorMs - 1,
      message: { role: 'user', content: echoContent(tool, question), at: '' } as AgentMessage,
    });
    const echoEntries = [
      ...visibleRuns
        .filter((r) => r.origin === 'user')
        .map((r) => echoOf(r.id, r.tool, r.question, ms(r.startedAt))),
      ...myActiveRuns
        .filter((a) => a.origin === 'user')
        .map((a) => echoOf(a.runId, a.tool, a.question, ms(a.startedAt ?? a.enqueuedAt))),
    ];
    return [...runEntries, ...activeEntries, ...stepEntries, ...msgEntries, ...echoEntries].sort(
      (a, b) => a.sortTime - b.sortTime,
    );
  }, [visibleRuns, myActiveRuns, agentSteps, messages]);

  const thinkingSince = useMemo(() => {
    const cands: number[] = [];
    const since = prLocalId !== undefined ? runningPrs.get(prLocalId) : undefined;
    if (since !== undefined) cands.push(since);
    const lastStepAt = agentSteps[agentSteps.length - 1]?.at;
    if (lastStepAt) {
      const t = new Date(lastStepAt).getTime();
      if (Number.isFinite(t)) cands.push(t);
    }
    const lastRun = visibleRuns[visibleRuns.length - 1];
    const lastRunEnd = lastRun?.finishedAt ?? lastRun?.startedAt;
    if (lastRunEnd) {
      const t = new Date(lastRunEnd).getTime();
      if (Number.isFinite(t)) cands.push(t);
    }
    return cands.length ? Math.max(...cands) : Date.now();
  }, [runningPrs, prLocalId, agentSteps, visibleRuns]);

  return { timeline, thinkingSince };
}
