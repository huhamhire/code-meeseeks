import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRunTool } from '@meebox/shared';
import { formatElapsed, formatStartTime, inferPhase, runStatusLabel } from '../utils/format';
import { AnsiPre, Spinner } from './shared';

export function RunningView({
  tool,
  runId,
  lines,
  startedAt,
  model,
}: {
  tool: ReviewRunTool;
  runId: string;
  lines: ReadonlyArray<string>;
  startedAt: number;
  /** 当前 active LLM profile.model — 跟 RunMeta 同源放在 chip 行，让 running
      跟 succeeded 视觉一致；可选 (无 active profile 时不显示) */
  model: string | null;
}) {
  const { t } = useTranslation();
  // 末行追加时自动滚到底
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // 计时器：pr-agent stdout 长间隔时让用户感知到不是卡死。1s 粒度即可
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const phase = useMemo(() => inferPhase(lines, t), [lines, t]);

  // 跟 RunMeta 完全同结构的 chip 行。running 跟 succeeded/failed 共享一套视觉
  // 骨架，用户从列表扫一眼能在固定位置看到 tool / 状态 / 模型 / 时长。strategy
  // 运行时策略是部署细节用户不关心，撤掉；model 是真正影响 review 质量的变量
  return (
    <div className="chat-run-running" data-run-id={runId}>
      <header className="chat-run-meta">
        <span className={`chat-run-tool chat-run-tool-${tool}`}>/{tool}</span>
        <span className="chat-chip chat-run-status chat-run-status-running">
          <Spinner />
          {runStatusLabel('running', t)}
        </span>
        {model && (
          <span
            className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-model"
            title={t('chatPane.modelTitle', { model })}
          >
            {model}
          </span>
        )}
        <span className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-duration">
          {formatElapsed(elapsedMs)}
        </span>
        {/* 开始时间：跟 RunMeta 同模 — 纯文本右对齐，让 running 跟 succeeded
            两态最右侧元素位置稳定 */}
        <span
          className="chat-run-time"
          title={t('chatPane.startedAtTitle', { time: new Date(startedAt).toLocaleString() })}
        >
          {formatStartTime(startedAt)}
        </span>
      </header>
      {phase && (
        <div className="chat-chip chat-chip-md chat-chip-quiet chat-chip-accent chat-run-phase">
          {phase}
        </div>
      )}
      <AnsiPre
        className="chat-run-stdout"
        preRef={ref}
        text={lines.join('\n')}
        placeholder={t('chatPane.waitingOutput')}
      />
    </div>
  );
}
