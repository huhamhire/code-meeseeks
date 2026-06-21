import autopilotJudge from '../resources/prompts/autopilot-judge.md?raw';
import judge from '../resources/prompts/judge.md?raw';
import protocol from '../resources/prompts/protocol.md?raw';
import summary from '../resources/prompts/summary.md?raw';

/**
 * 编排器提示词模板（见 docs/arch/06-agent.md「提示词模版」）：静态正文外置到 `resources/prompts/` 的
 * `.md`，构建期经 Vite `?raw` 内联。动态值用 `{{name}}` 占位符、由 utils 的 fillTemplate 注入；条件拼接
 * 与大块动态内容（describe/review 文本、PR 列表等）仍由各调用方在 TS 侧组装。
 */
export const PROMPT_TEMPLATES = {
  /** 规划 ReAct 协议（动作格式 / 评审收尾骨架 / 记忆规则 / 计划 / 会话范围）。占位：overview/findings/suggestions。 */
  protocol,
  /** 追问判读 user 指令（占位：maxAsks/language）；describe/review 正文由调用方追加。 */
  judge,
  /** 收尾总结 user 指令 + 三段骨架（占位：maxChars/overview/findings/suggestions）；正文由调用方追加。 */
  summary,
  /** AutoPilot 批量判定 system 基底（无占位）；项目规则由调用方按需追加。 */
  autopilotJudge,
} as const;
