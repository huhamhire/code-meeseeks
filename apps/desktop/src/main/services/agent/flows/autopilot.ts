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
 * Runs one AutoPilot pass (the busy lock set / reset wraps the whole run). Only triggered by
 * Orchestrator.runAutopilotIfDue after passing admission.
 * Candidate admission (hard gates, top-down): (1) only "review-requested + pending"; (2) already has
 * describe/review output (succeeded / in progress) → already reviewed / reviewing, excluded; (3) ledger
 * dedup for this version already judged skip. Then truncate by batch_size, batch-judge, and orchestrate
 * reviews in parallel.
 */
export async function autopilotPass(runtime: OrchestratorRuntime): Promise<void> {
  const { bootstrap, stateStore, ensureAgentDir, logger } = runtime.ctx;
  const ap = bootstrap.config.agent.autopilot;
  runtime.setAutopilotBusy(true);
  try {
    const prs = await listStoredPullRequests(stateStore);
    const candidates: StoredPullRequest[] = [];
    // Admission funnel counters (to locate which gate blocked when there are 0 candidates — helps debug
    // "why does it no longer trigger").
    let reviewReqPending = 0; // matched "review-requested + pending"
    let alreadyReviewed = 0; // among those, excluded for already having describe/review output (succeeded / in progress)
    let skipDeduped = 0; // among those, excluded for already being judged skip this version
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
      // Still evaluating on schedule, just no new eligible PR right now — log the funnel counters to avoid being misread as "not running".
      logger.info(
        { total: prs.length, reviewReqPending, alreadyReviewed, skipDeduped },
        'autopilot pass: no eligible candidates',
      );
      return;
    }

    const agentContext = await loadAgentContext(await ensureAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    // Background input for the first judge step: classify each candidate as "pure branch merge". The
    // decision is **based on the actual commit structure** — one commits API call to see "whether all
    // commits are merges"; the branch name is only a sourceMainline background signal, never decisive alone.
    // Runs in parallel, roughly one round-trip overall.
    // Failure does not block (no commits → inconclusive, treated as non-merge, still carrying the sourceMainline signal for the judge to weigh).
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
      // Batch judgment (exception rules come from AGENTS.md; branch info + branch-merge signal as background input).
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
      // Persist "skip" decisions first (no tool cost, sequential write is fine); collect "review" decisions (along with their execution plan) for parallel orchestration.
      const toReview: Array<{ pr: StoredPullRequest; plan?: ReviewPlan }> = [];
      for (const d of decisions) {
        const pr = byId.get(d.prLocalId);
        if (!pr) continue;
        // Log every decision (with review/skip + reason + plan + branch-merge signal) to help debug "whether the judge runs by the rules".
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
        // d.plan omitted → micro-flow uses the default full set; the injection point for rule-driven plans (see JudgeDecision.plan).
        toReview.push({ pr, plan: d.plan });
      }
      // Parallel orchestration of multi-PR reviews: each orchestration awaits its own tool run without blocking the others, filling up run-queue concurrency as much as possible.
      await Promise.all(
        toReview.map(async ({ pr, plan }) => {
          // AutoPilot background review has no AbortController, but is still marked "running" — the pure thinking phase also shows on the PR list item.
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
            // done: persist the "review summary" message + ledger (with verdict) + broadcast (same as manual review). Failure / pause does not write the ledger.
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
