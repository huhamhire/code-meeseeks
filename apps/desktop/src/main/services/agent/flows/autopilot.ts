import {
  type BranchMergeVerdict,
  classifyBranchMerge,
  judgeAutopilotBatch,
  loadAgentContext,
  type ReviewPlan,
} from '@meebox/agent';
import {
  getAutopilotLedger,
  hasReviewOutput,
  listStoredPullRequests,
  writeAutopilotLedger,
} from '@meebox/poller';
import type { PrCommit, StoredPullRequest } from '@meebox/shared';
import type { OrchestratorRuntime } from '../runtime.js';
import { runReviewForPr } from './review.js';

/**
 * 跑一遍 AutoPilot pass（busy 锁置位 / 复位包住全程）。仅由 Orchestrator.runAutopilotIfDue 通过准入后触发。
 * 候选准入（硬性门控，自上而下）：① 仅「待我评审 + 待处理」；② 已有 describe/review 产出（成功 / 进行中）
 * → 已评审过 / 评审中，排除；③ 本版本已被判 skip 的台账去重。再按 batch_size 截断，批量判定后并行编排评审。
 */
export async function autopilotPass(runtime: OrchestratorRuntime): Promise<void> {
  const { bootstrap, stateStore, ensureAgentDir, logger } = runtime.ctx;
  const ap = bootstrap.config.agent.autopilot;
  runtime.setAutopilotBusy(true);
  try {
    const prs = await listStoredPullRequests(stateStore);
    const candidates: StoredPullRequest[] = [];
    // 准入漏斗计数（用于 0 候选时定位卡在哪一道闸——便于排查「为何不再触发」）。
    let reviewReqPending = 0; // 命中「待我评审 + 待处理」
    let alreadyReviewed = 0; // 其中已有 describe/review 产出（成功 / 进行中）而被排除
    let skipDeduped = 0; // 其中本版本已被判定跳过而被排除
    for (const pr of prs) {
      if (candidates.length >= ap.batch_size) break;
      if (!pr.discoveryFilters.includes('review-requested')) continue;
      if (pr.localStatus !== 'pending') continue;
      reviewReqPending++;
      if (await hasReviewOutput(stateStore, pr.localId)) {
        alreadyReviewed++;
        continue;
      }
      const ledger = await getAutopilotLedger(stateStore, pr.localId);
      if (ledger?.decision === 'skipped' && ledger.autoReviewedUpdatedAt === pr.updatedAt) {
        skipDeduped++;
        continue;
      }
      candidates.push(pr);
    }
    if (candidates.length === 0) {
      // 仍在按周期评估，只是当前无新合格 PR——把漏斗计数打出来，避免被误读成「没在跑」。
      logger.info(
        { total: prs.length, reviewReqPending, alreadyReviewed, skipDeduped },
        'autopilot pass: no eligible candidates',
      );
      return;
    }

    const agentContext = await loadAgentContext(await ensureAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    // 第一步 judge 的背景输入：逐候选判「纯分支合并」。判定**以实际提交结构为准**——拉一次 commits API
    // 看「提交是否全为 merge」；分支名只作 sourceMainline 背景信号、不单独定论。并行跑，整体约一轮 round-trip。
    // 失败不阻断（无 commits → inconclusive、按非合并处理，仍带 sourceMainline 信号交 judge 权衡）。
    const branchMergeByPr = new Map<string, BranchMergeVerdict>();
    await Promise.all(
      candidates.map(async (p) => {
        const sourceBranch = p.sourceRef.displayId;
        const targetBranch = p.targetRef.displayId;
        let commits: PrCommit[] | undefined;
        try {
          commits = await runtime.ctx.pr
            .adapterFor(p)
            ?.prs.listPullRequestCommits(p.repo, p.remoteId);
        } catch (err) {
          logger.debug(
            { err, prLocalId: p.localId },
            'branch-merge commits check failed (ignored)',
          );
        }
        branchMergeByPr.set(
          p.localId,
          classifyBranchMerge({ sourceBranch, targetBranch, commits: commits ?? undefined }),
        );
      }),
    );

    await runtime.withAgentChat(async (chat) => {
      // 批量判定（例外规则来自 AGENTS.md；分支信息 + 分支合并信号作背景输入）。
      const { decisions } = await judgeAutopilotBatch(chat, {
        candidates: candidates.map((p) => {
          const v = branchMergeByPr.get(p.localId);
          return {
            prLocalId: p.localId,
            title: p.title,
            description: p.description,
            sourceBranch: p.sourceRef.displayId,
            targetBranch: p.targetRef.displayId,
            branchMerge: v?.isBranchMerge,
            sourceMainline: v?.sourceMainline,
          };
        }),
        agentsRules: agentContext.files.agents,
      });
      const byId = new Map(candidates.map((p) => [p.localId, p] as const));
      // 先落「跳过」决策（无工具开销，顺序写盘即可）；收集「评审」决策（连同其执行计划）待并行编排。
      const toReview: Array<{ pr: StoredPullRequest; plan?: ReviewPlan }> = [];
      for (const d of decisions) {
        const pr = byId.get(d.prLocalId);
        if (!pr) continue;
        // 每条决策都记日志（含 review/skip + 原因 + 计划 + 分支合并信号），便于排查「judge 是否在按规则跑」。
        logger.info(
          {
            prLocalId: pr.localId,
            review: d.review,
            reason: d.reason,
            plan: d.plan?.steps,
            branchMerge: branchMergeByPr.get(pr.localId)?.isBranchMerge ?? false,
          },
          'autopilot judge decision',
        );
        if (!d.review) {
          await writeAutopilotLedger(stateStore, {
            prLocalId: pr.localId,
            autoReviewedUpdatedAt: pr.updatedAt,
            decision: 'skipped',
            reason: d.reason,
            at: new Date().toISOString(),
          });
          continue;
        }
        // d.plan 省略 → 微流程走默认全集；规则驱动计划的注入点（见 JudgeDecision.plan）。
        toReview.push({ pr, plan: d.plan });
      }
      // 多 PR 评审并行编排：各编排 await 自己的工具 run 时彼此不挡，让 run-queue 并发尽量被填满。
      await Promise.all(
        toReview.map(async ({ pr, plan }) => {
          // AutoPilot 后台评审无 AbortController，但同样标记「执行中」——纯思考阶段也在 PR 列表项显示。
          runtime.markRunning(pr.localId);
          try {
            const session = await runReviewForPr(
              runtime,
              pr,
              agentContext,
              chat,
              undefined,
              true,
              plan,
            );
            // done：落「评审总结」消息 + 台账（含 verdict）+ 广播（与手动评审一致）。失败 / 暂停不落台账。
            await runtime.recordReviewSummaryMessage(pr, session);
          } finally {
            runtime.unmarkRunning(pr.localId);
          }
        }),
      );
    });
    logger.info({ candidates: candidates.length }, 'autopilot pass done');
  } catch (err) {
    logger.warn({ err }, 'autopilot pass failed (ignored)');
  } finally {
    runtime.setAutopilotBusy(false);
  }
}
