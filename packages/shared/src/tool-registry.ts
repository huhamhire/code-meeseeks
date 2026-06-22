/**
 * 统一工具注册表（唯一真相源，见 docs/arch/06-agent.md「工具修改红线」）。新增 / 调整工具只改这里，
 * 下列派生物自动跟随：
 * - `ReviewRunTool`：pr-agent 运行队列工具 id（`isRun`）。
 * - agent 工具目录 `buildToolCatalog`：按 `kind` 标读 / 改、按 `grant` 放行修改类（红线策略在 agent 层）。
 * - 规划红线允许集：`READ_RUN_TOOL_IDS`。
 */

/** 工具读 / 改分类。read 始终可用；mutating 对远端有副作用、默认禁止，仅 grant 放行。 */
export type ToolKind = 'read' | 'mutating';

export interface ToolSpec {
  /** 规范 id（无斜杠），如 `describe`。 */
  id: string;
  /** 展示 / 调用名（带斜杠），如 `/describe`。 */
  command: string;
  /** 一句话说明（注入工具目录提示词；面向 LLM，英语）。 */
  summary: string;
  kind: ToolKind;
  /** 修改类放行所需的 grant 键；读类省略。 */
  grant?: string;
  /** 是否为 pr-agent 运行队列工具（经 run-queue 产出 ReviewRun）。 */
  isRun: boolean;
}

export const TOOLS = [
  {
    id: 'describe',
    command: '/describe',
    summary: 'Generate the PR description.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'review',
    command: '/review',
    summary: 'Generate review findings.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'ask',
    command: '/ask',
    summary: 'Ask a free-form question about the PR.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'improve',
    command: '/improve',
    summary: 'Generate code improvement suggestions.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'approve',
    command: '/approve',
    summary: 'Approve the PR.',
    kind: 'mutating',
    grant: 'approve',
    isRun: false,
  },
  {
    id: 'needswork',
    command: '/needswork',
    summary: 'Request changes on the PR.',
    kind: 'mutating',
    grant: 'needs_work',
    isRun: false,
  },
  {
    id: 'publish',
    command: '/publish',
    summary: 'Publish review comments to the remote.',
    kind: 'mutating',
    grant: 'publish_comment',
    isRun: false,
  },
] as const satisfies readonly ToolSpec[];

/** pr-agent 运行队列工具 id（注册表中 `isRun` 的项）。 */
export type ReviewRunTool = Extract<(typeof TOOLS)[number], { isRun: true }>['id'];

/** 读类运行工具 id 集合：规划（ReAct）红线只放行这些工具自主调用，校验用。 */
export const READ_RUN_TOOL_IDS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.isRun && t.kind === 'read').map((t) => t.id),
);
