import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Finding, ReviewDraft, ReviewRun } from '@meebox/shared';
import { RetryIcon, TrashIcon } from '../../../common';
import { orderFindings } from '../utils/findings';
import { formatStartTime, formatTokens, runStatusLabel } from '../utils/format';
import { extractTokenUsage, type TokenUsage } from '../utils/tokens';
import { AnsiPre, AskQuestion } from './shared';
import { FindingCard } from './FindingCard';

function RunMeta({ run, onDelete }: { run: ReviewRun; onDelete: () => void }) {
  const { t } = useTranslation();
  const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
  // 优先用 run.tokenUsage（litellm callback 捕获的 API 真实 usage，见 sitecustomize）；
  // 历史 run 没这字段时回退到从 stdout 抓取的旧估算，保持向后兼容。
  const usage: TokenUsage = run.tokenUsage
    ? {
        prompt: run.tokenUsage.promptTokens,
        completion: run.tokenUsage.completionTokens,
        total: run.tokenUsage.totalTokens,
      }
    : run.stdout
      ? extractTokenUsage(run.stdout)
      : {};
  return (
    <header className="chat-run-meta">
      <span className={`chat-run-tool chat-run-tool-${run.tool}`}>/{run.tool}</span>
      <span className={`chat-chip chat-run-status chat-run-status-${run.status}`}>
        {runStatusLabel(run.status, t)}
      </span>
      {/* 模型 chip 取代运行时策略 chip — strategy 是部署细节用户不
          关心，model 是真正影响 review 质量的变量 */}
      {run.model && (
        <span
          className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-model"
          title={t('chatPane.modelTitle', { model: run.model })}
        >
          {run.model}
        </span>
      )}
      {/* 只分别展示输入(↑prompt,绿) / 输出(↓completion,红)，不显示总数。旧 run 可能只有 prompt */}
      {usage.prompt !== undefined || usage.completion !== undefined ? (
        <span
          className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-tokens"
          title={t('chatPane.tokensTitle', {
            prompt: usage.prompt ?? '—',
            completion: usage.completion ?? '—',
          })}
        >
          {usage.prompt !== undefined && (
            <>
              <span className="chat-token-in">↑</span>
              {formatTokens(usage.prompt)}
            </>
          )}
          {usage.prompt !== undefined && usage.completion !== undefined ? ' / ' : ''}
          {usage.completion !== undefined && (
            <>
              <span className="chat-token-out">↓</span>
              {formatTokens(usage.completion)}
            </>
          )}
        </span>
      ) : null}
      <span className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-duration">
        {duration}
      </span>
      {/* 开始时间：纯文本不带胶囊背景，margin-left:auto 顶到最右 — 跟左侧
          tool/status/strategy chip 拉开距离，视觉权重比 chip 轻一档 */}
      <span
        className="chat-run-time"
        title={t('chatPane.startedAtTitle', { time: new Date(run.startedAt).toLocaleString() })}
      >
        {formatStartTime(run.startedAt)}
      </span>
      {/* 删除本条 run 记录：状态行最右的小垃圾桶按钮（仅删该 run，不影响其它记录 / 徽标）。 */}
      <button
        type="button"
        className="chat-run-delete"
        onClick={onDelete}
        title={t('chatPane.deleteRunTitle')}
        aria-label={t('chatPane.deleteRunAria')}
      >
        <TrashIcon />
      </button>
    </header>
  );
}

export function RunResultView({
  run,
  onRetry,
  onDelete,
  canRetry,
  drafts,
  onJumpToDraft,
  onRejectFinding,
  onNavigateToFinding,
}: {
  run: ReviewRun;
  onRetry: (run: ReviewRun) => void;
  /** 删除本条 run 记录（仅该 run）。 */
  onDelete: (runId: string) => void;
  /** 由父组件按"最后一条 + 无活动 run"判定；false 时失败 / 取消 run 也不显示重试键 */
  canRetry: boolean;
  /** 本 PR 当前草稿池快照；FindingCard 据此显示 status chip + 决定 reject 行为 */
  drafts: ReadonlyArray<ReviewDraft>;
  /** 点击 finding card 上"→ 跳到代码编辑"时触发。父组件做懒创建 + 跳转 */
  onJumpToDraft: (finding: Finding, run: ReviewRun) => void;
  /** 拒绝某条 finding：创建 / 更新草稿到 status='rejected' */
  onRejectFinding: (finding: Finding, run: ReviewRun) => void;
  /** 点击 finding 锚点：仅导航到 Diff 对应行（不进编辑态） */
  onNavigateToFinding: (finding: Finding) => void;
}) {
  const { t } = useTranslation();
  const findings = run.findings ?? [];
  // 失败 + 取消都用红 banner 提示。取消是用户主动行为，UI 用更轻文案区分
  const isFailed = run.status === 'failed';
  const isCancelled = run.status === 'cancelled';
  const isFailedOrCancelled = isFailed || isCancelled;
  const stdout = run.stdout ?? '';
  // "原始输出" 折叠区独立 per-run 维护状态，互不影响。失败 / 取消默认展开方便排障，
  // 成功默认关闭只是诊断兜底
  const [showRawStdout, setShowRawStdout] = useState(isFailedOrCancelled);
  // /ask 工具：把用户提问展示在 meta 行**下方**，跟 /ask 这个动作绑成一组；
  // 上方再放用户气泡会跟 meta 行重复信息源，移到动作下方更符合"动作 → 输入"语序
  const userMessage = run.tool === 'ask' ? run.question?.trim() : undefined;
  return (
    <div className="chat-run-result">
      <RunMeta run={run} onDelete={() => onDelete(run.id)} />
      {userMessage && <AskQuestion text={userMessage} />}
      {/* 原始输出：始终紧跟 meta 行，让用户在任何状态下都能在固定位置找到日志。
          失败 / 取消默认展开，成功默认收起 */}
      {stdout.length > 0 && (
        <details
          className="chat-run-raw"
          open={showRawStdout}
          onToggle={(e) => {
            if (e.currentTarget.open !== showRawStdout) setShowRawStdout(e.currentTarget.open);
          }}
        >
          <summary>{t('chatPane.rawOutput', { n: stdout.length })}</summary>
          <AnsiPre className="chat-run-stdout" text={stdout} />
        </details>
      )}
      {isFailedOrCancelled && (
        <div className="chat-error" role="alert">
          <strong>
            {isCancelled
              ? t('chatPane.runCancelled')
              : run.errorReason === 'llm-error'
                ? t('chatPane.llmCallFailed')
                : run.errorReason
                  ? t('chatPane.runFailedReason', { reason: run.errorReason })
                  : t('chatPane.runFailed')}
            {/* llm-error 时 exitCode 是 0 (pr-agent 自己 catch 了)，显示出来反而
                让用户误以为没出错，所以跳过 */}
            {run.exitCode != null &&
              !isCancelled &&
              run.errorReason !== 'llm-error' &&
              ` · exit ${String(run.exitCode)}`}
          </strong>
          {canRetry && (
            <button
              type="button"
              className="chat-run-retry"
              onClick={() => onRetry(run)}
              title={
                run.question
                  ? t('chatPane.retryWithQuestionTitle', { tool: run.tool, question: run.question })
                  : t('chatPane.retryTitle', { tool: run.tool })
              }
              aria-label={t('chatPane.retryAria')}
            >
              <RetryIcon />
            </button>
          )}
          {run.errorMessage && !isCancelled && (
            <pre className="chat-error-detail">{run.errorMessage}</pre>
          )}
          {/* 失败 / 取消不再单独展示输出区块：pr-agent 日志已在上方可折叠的「原始输出」（stdout 含
              [pr-agent stdout log] 段，与 stderr 同源），避免同一份日志重复成两块。 */}
        </div>
      )}

      {/* 失败 / 取消不渲染 findings：取消的 /describe 会把部分 stdout 解析成「段落」误当结果展示。
          失败 / 取消统一只保留上方可折叠的「原始输出」+ 状态横幅，不在下方另起输出区块。 */}
      {!isFailedOrCancelled &&
        (findings.length > 0 ? (
          <ul className="chat-finding-list">
            {orderFindings(findings).map((f) => {
              // 同 run 内 finding 跟草稿一对一：source.runId+findingId 反查。命中后
              // FindingCard 据此显示状态 chip + 跳转/拒绝按钮行为分支
              const relatedDraft = drafts.find(
                (d) =>
                  d.source !== undefined &&
                  d.source.runId === run.id &&
                  d.source.findingId === f.id,
              );
              return (
                <FindingCard
                  key={f.id}
                  finding={f}
                  relatedDraft={relatedDraft}
                  onJump={() => onJumpToDraft(f, run)}
                  onReject={() => onRejectFinding(f, run)}
                  onNavigate={() => onNavigateToFinding(f)}
                />
              );
            })}
          </ul>
        ) : run.status === 'succeeded' ? (
          <div className="chat-finding-empty muted">{t('chatPane.noFindings')}</div>
        ) : null)}
    </div>
  );
}
