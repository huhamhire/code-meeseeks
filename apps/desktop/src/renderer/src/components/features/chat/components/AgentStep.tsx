import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentStep } from '@meebox/shared';
import { RobotIcon } from '../../../common';
import { formatElapsed } from '../utils/format';
import { Spinner, TokenStat } from './shared';

/**
 * 内联思考步骤（类 Claude Code「先思考→定步骤→执行步骤」）：穿插在时间线里、排在所选工具的 run
 * 卡片之前。两行展示——首行带 bullet 标记的「已思考 xx s」（单步思考耗时，非总累计），次行另起展示
 * 步骤结果（思考内容 / 判读结论）。不展示选了哪个工具（由随后的 run 卡片体现）；工具执行的进度 /
 * 计时也归 run 卡片。
 */
export function AgentStepRow({ step }: { step: AgentStep }) {
  const { t } = useTranslation();
  // 首行始终带 bullet 标记：有思考计时 → 「已思考 xx s」；无计时（如微流程固定派发步）→ 用思考内容
  // 当首行，保证每一步都可见、都有分段标记，绝不渲染成空行。
  const hasTime = step.thinkMs != null;
  const headText = hasTime
    ? t('chatPane.agent.thoughtFor', { time: formatElapsed(step.thinkMs ?? 0) })
    : step.thought;
  return (
    <div className="chat-agent-step" role="note">
      <div className="chat-agent-step-head">
        <span className="chat-agent-step-bullet" aria-hidden>
          •
        </span>
        {/* AutoPilot 后台评审的首步打机器人 chip，标识「这次评审由 AutoPilot 触发」。 */}
        {step.autopilot && (
          <span className="chat-agent-step-autopilot" title={t('chatPane.autopilotRun')}>
            <RobotIcon size={12} />
          </span>
        )}
        {headText && <span>{headText}</span>}
        {/* 本步**单独**的 token 用量（不累计）：judge / 总结 / 规划等经独立 LLM 通道的推理步带值；
            与 run 卡片同款 ↑输入(绿)[⛁缓存]/↓输出(红)，输入输出各自独立 hover、靠行尾对齐。
            describe/review/ask 的开销在各自 run 卡片上。 */}
        {step.usage &&
        (step.usage.promptTokens !== undefined || step.usage.completionTokens !== undefined) ? (
          <span className="chat-agent-step-tokens">
            <TokenStat
              prompt={step.usage.promptTokens}
              completion={step.usage.completionTokens}
              cacheRead={step.usage.cacheReadTokens}
              separator=" "
            />
          </span>
        ) : null}
      </div>
      {hasTime && step.thought && <div className="chat-agent-step-body">{step.thought}</div>}
      {step.kind === 'judge' && step.result && (
        <div className="chat-agent-step-body muted">{step.result}</div>
      )}
    </div>
  );
}

/**
 * 实时「思考中」指示：仅在 Agent 自身 LLM 正在推理（无工具 run 占用 / 排队）时挂载。计时锚定到传入的
 * `since`（最近一次活动结束时刻，由父级从持久数据算出），而非组件挂载——切走再切回不清零；新一步产生
 * 后 since 前移 → 计时回到当前步从零起算（仍是单步思考时长，非总累计）。
 * 首行布局与已完成步骤对齐：spinner 充当进行中的 bullet 标记，「思考中」后紧贴计时。
 */
export function ThinkingLive({ since }: { since: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="chat-agent-step" role="status">
      <div className="chat-agent-step-head">
        <Spinner />
        <span>
          {t('chatPane.agent.thinking')} {formatElapsed(Math.max(0, now - since))}
        </span>
      </div>
    </div>
  );
}
