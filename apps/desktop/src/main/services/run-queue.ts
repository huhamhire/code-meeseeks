import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadAgentRules } from '@meebox/agent';
import type { PragentRunInfo } from '@meebox/ipc';
import { PrAgentRunError } from '@meebox/pr-agent-bridge';
import {
  dropPendingFindingDrafts,
  finishReviewRun,
  makeRunId,
  parseReviewOutput,
  startReviewRun,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type {
  ReviewRun,
  ReviewRunStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import { getMainLanguage, t } from '../i18n/index.js';
import { buildPragentEnv, resolveActiveLlmProfile } from '../utils/agent.js';
import { buildPrContext } from '../utils/pr-context.js';
import { buildProxyEnv } from '../utils/proxy.js';
import type { IpcContext } from './context.js';
import {
  accumulateUsageSentinel,
  finalizeUsage,
  newUsageAcc,
  stripUsageSentinels,
} from './common/usage.js';

/** pr-agent run 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。 */
export type RunPriority = 'user' | 'agent';

export interface RunQueueService {
  /**
   * 入队一个 pr-agent run（与用户手动 run 共用同一队列 / 并发 / 取消机制）。dedup：同 PR
   * 同工具已在执行 / 排队则抛错（/ask 不限）。resolve 完成的 ReviewRun。
   */
  enqueuePragentRun(
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority?: RunPriority,
  ): Promise<ReviewRun>;
  /** 取消一个 run（pragent:cancel）：active→SIGKILL；waiting→出队 + reject；都不匹配→ok:false。 */
  cancel(runId: string): { ok: boolean };
  /** 当前队列快照（pragent:queue / 广播用）。 */
  snapshot(): { active: PragentRunInfo[]; waiting: PragentRunInfo[] };
  /** 取消某 PR 的全部 run：active 的 SIGKILL，waiting 的出队 + reject。 */
  cancelRunsForPr(localId: string): void;
  /** active + waiting 涉及的 PR localId 集合（terminateAgentsForGonePrs 用）。 */
  queuedPrLocalIds(): string[];
  /** 应用退出时中止所有进行中的 run，返回被中止的 run 数。 */
  abortAllActiveRuns(): number;
}

export function createRunQueueService(ctx: IpcContext): RunQueueService {
  const {
    bootstrap,
    logger,
    getPrAgentBridge,
    embeddedPythonPath,
    stateStore,
    repoMirror,
    broadcast,
    adapterFor,
    repoIdentityFor,
    resolveDiffBaseSha,
    effectiveAgentDir,
  } = ctx;

  // === pr-agent run 队列 ===
  //
  // FIFO 队列，同时只有 1 条在跑 (避免撞 LLM rate limit / 抢 worktree)，
  // 其余在 waiting 排队。每次 active 完成 / 取消 → 自动开下一条。
  //
  // 设计要点：
  //   - runId 在入队时就分配 (跟最终落盘 ReviewRun.id 一致)，cancel(runId) 在
  //     active / waiting 两种状态都能精确定位
  //   - queued 状态不落盘；被取消时直接 reject 原 Promise，不留 disk artifact
  //   - 真正 dequeue 才 startReviewRun 写 disk + 跑 pr-agent
  //   - 每次队列变化广播 'pragent:queueChanged'，renderer store 同步
  interface QueueItem {
    info: PragentRunInfo;
    req: { localId: string; tool: ReviewRunTool; question?: string };
    pr: StoredPullRequest;
    resolve: (run: ReviewRun) => void;
    reject: (err: Error) => void;
    /** 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。见 §7 调度。 */
    priority: RunPriority;
    /** 仅 active 状态填；用于 cancel SIGKILL */
    ac?: AbortController;
  }
  const waiting: QueueItem[] = [];
  // 并发运行中的 run（runId → item）；上限 maxConcurrency。post-Docker 下每个 run
  // 独立 worktree（路径带 nonce）+ 独立子进程，并发安全；串行不再是正确性要求。
  const active = new Map<string, QueueItem>();
  const maxConcurrency = bootstrap.config.pr_agent.max_concurrency;

  const snapshot = (): { active: PragentRunInfo[]; waiting: PragentRunInfo[] } => ({
    active: [...active.values()].map((q) => q.info),
    waiting: waiting.map((q) => q.info),
  });

  const broadcastQueueChanged = (): void => {
    broadcast('pragent:queueChanged', snapshot());
  };

  // /ask 输出去重：pr-agent answer markdown 里会回显完整问题（以及我们追加到问题末尾的语言要求），
  // 跟 UI chat-user-msg 气泡重复。逐行精确匹配（trim 后整行 == 任一给定串）删掉，保留其余正文。
  const stripAskQuestionEcho = (md: string, ...echoed: string[]): string => {
    const qs = new Set(echoed.map((q) => q.trim()).filter(Boolean));
    if (!qs.size || !md) return md;
    return md
      .split('\n')
      .filter((line) => !qs.has(line.trim()))
      .join('\n');
  };

  // embedded 策略：执行期在嵌入式安装目录的 settings/ 与 settings_prod/ 补空
  // .secrets.toml（pr-agent 启动会去找该文件，缺失就打 WARNING；我们走 env 传密钥
  // 不用 secrets.toml，写个空文件压掉告警）。
  // memo 化：只在首个 embedded run 解析一次 pr_agent 目录 + 写文件，后续直接复用。
  // importlib.util.find_spec 仅定位不 import pr_agent，快；失败仅 warn 不阻断 run。
  const execFileP = promisify(execFile);
  let embeddedSecretsEnsured: Promise<void> | null = null;
  const ensureEmbeddedSecrets = (pythonPath: string): Promise<void> => {
    embeddedSecretsEnsured ??= (async () => {
      const { stdout } = await execFileP(pythonPath, [
        '-c',
        "import importlib.util,os;print(os.path.dirname(importlib.util.find_spec('pr_agent').origin))",
      ]);
      const prAgentDir = stdout.trim();
      for (const sub of ['settings', 'settings_prod']) {
        const dir = path.join(prAgentDir, sub);
        await fs.mkdir(dir, { recursive: true });
        const f = path.join(dir, '.secrets.toml');
        try {
          await fs.access(f);
        } catch {
          await fs.writeFile(
            f,
            '# meebox placeholder: silence pr-agent warning about a missing .secrets.toml\n',
          );
        }
      }
    })().catch((err: unknown) => {
      logger.warn({ err }, 'ensure embedded .secrets.toml failed (ignored)');
    });
    return embeddedSecretsEnsured;
  };

  /**
   * 真正执行一个 queue item：startReviewRun → worktree → bridge.run → finishWith。
   * 由 pump() 调用，签名稳定后跟 queue 主体解耦；任何抛错都被 pump 兜成
   * Promise reject，外层 pragent:run 调用方收到。
   */
  const executeRun = async (item: QueueItem): Promise<ReviewRun> => {
    const prAgentBridge = getPrAgentBridge();
    if (!prAgentBridge) throw new Error(t('prAgent.notReady'));
    const { req, pr } = item;
    // 提前 resolve active LLM profile — model 字段要随 startReviewRun 一起落
    // 盘，让 UI 在 meta 行展示"这次 run 用的什么模型"。后面 buildPragentEnv
    // 同样会用到，这里 resolve 一次复用
    const activeLlmForRecord = resolveActiveLlmProfile(bootstrap.config.llm);
    // 用入队预分配的 runId 覆盖 startReviewRun 的自生 id，让 cancel(runId) 在 active
    // 状态也能精确定位 (跟入队时给的 runId 一致)
    const run = await startReviewRun(stateStore, {
      id: item.info.runId,
      prLocalId: pr.localId,
      tool: req.tool,
      question: req.tool === 'ask' ? req.question : undefined,
      prAgentVersion: prAgentBridge.version,
      strategy: prAgentBridge.strategy,
      // 持久化用 profile.model 原文，不做 normalizeModel 前缀处理 — 跟用户
      // Settings 里看到的名字一致更直观
      model: activeLlmForRecord?.model || undefined,
    });
    // 把入队时 startedAt=null 的 info 升级为 active 形态 + 广播
    item.info = { ...item.info, startedAt: run.startedAt };
    broadcastQueueChanged();
    logger.info(
      { runId: run.id, localId: pr.localId, tool: req.tool, strategy: prAgentBridge.strategy },
      'pragent run start',
    );
    const t0 = Date.now();
    // 真实 token 用量累加器：sitecustomize 的 litellm callback 把每次调用的 usage 以
    // `@@MEEBOX_USAGE@@ {json}` 哨兵行打到 stderr，下面 onLine 拦截累加（无需临时文件 / env）。
    const usageAcc = newUsageAcc();
    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      // 拦截 usage 哨兵行：累加后不转发给 renderer（避免污染实时日志）。
      if (stream === 'stderr' && accumulateUsageSentinel(line, usageAcc)) return;
      broadcast('pragent:runProgress', { runId: run.id, line, stream });
    };

    const finishWith = async (patch: Parameters<typeof finishReviewRun>[3]): Promise<ReviewRun> => {
      const updated = await finishReviewRun(stateStore, pr.localId, run.id, patch);
      return updated ?? { ...run, ...patch };
    };

    const repoId = repoIdentityFor(pr);
    await repoMirror.syncMirror(repoId);
    // pr-agent 的 LOCAL__TARGET_BRANCH 用固定 merge-base（与 UI diff 同源）：让 AI 评审基于
    // 「PR 自分叉后引入的改动」，而非 targetRef.sha 漂移后混入别的 PR 的两点对比
    const diffBase = await resolveDiffBaseSha(pr);
    const wt = await repoMirror.materializeWorktree(repoId, pr.sourceRef.sha, diffBase);
    const ac = item.ac!;
    try {
      const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
      // LLM env + 全局 pr-agent 配置 (响应语言)。语言配置一期写死在 config 里，
      // UI 还不暴露切换；后续多语言时改成 Settings 入口
      const env: Record<string, string> = {
        // 代理 env 先铺底，LLM/语言配置在后（互不冲突，仅 HTTP(S)_PROXY 类）。
        // 开关开时让嵌入式 python(litellm/httpx) 经代理出网调 LLM。
        ...buildProxyEnv(bootstrap.config.proxy),
        ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
        CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
      };
      if (req.tool === 'improve') {
        // /improve 在 local provider 下只有「汇总建议 → publish_comment」一条可用路径
        // （shim 已强制 gfm_markdown=True）。committable/inline 模式会走
        // publish_code_suggestions → local provider 直接 NotImplementedError，显式关死兜底
        // （pr-agent 默认即 false，此处防上游翻默认值）。
        env['PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS'] = 'false';
        // persistent_comment（默认 true）会走 publish_persistent_comment_with_history →
        // get_issue_comments() 翻历史评论做增量更新 → local provider 不实现，每次 improve
        // 都刷一段 NotImplementedError traceback（被上游捕获后兜底 publish_comment，正文
        // 不丢但日志吵）。local 每次都是全新 worktree、无历史可翻，直接关掉走 publish_comment。
        env['PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT'] = 'false';
        // 输出与 /review /ask 的 review.md 分流：pr-agent 原生支持 local.review_path 覆盖
        // publish_comment 的落盘路径；相对路径按子进程 cwd（= worktree 根）解析。
        env['LOCAL__REVIEW_PATH'] = 'improve.md';
      }

      // 注给 pr-agent 的 EXTRA_INSTRUCTIONS 由三部分按顺序拼接：
      //   1. 语言指示：CONFIG__RESPONSE_LANGUAGE 对 /describe /review 够用，但
      //      /ask 走 [pr_questions] 配置段不那么严格遵守，必须显式 prompt 强化
      //   2. PR 上下文 (title / description / 已有评论)：local provider 自己不会
      //      去 Bitbucket 拉这些，必须我们这边喂；让 /describe /review 不只是看 diff
      //   3. 规则正文 (rules.dir 命中)：项目编码规约
      // /ask 只取 1 (语言)，跳 2/3 (用户问题往往跟历史评论 / 规约无关)
      const langDirective = languageDirectiveFor(getMainLanguage());
      let prContext = '';
      let matchedRuleInstructions = '';
      let matchedRuleId: string | undefined;
      if (req.tool !== 'ask') {
        const adapter = adapterFor(pr);
        if (adapter) {
          try {
            prContext = await buildPrContext({ pr, adapter, logger });
          } catch (err) {
            logger.warn(
              { err, runId: run.id, localId: pr.localId },
              'buildPrContext threw; proceeding without PR context',
            );
          }
        }

        const rules = await loadAgentRules(effectiveAgentDir(), {
          onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
        });
        const matched = pickMatchingRule(rules, {
          projectKey: pr.repo.projectKey,
          repoSlug: pr.repo.repoSlug,
          targetBranch: pr.targetRef.displayId,
          tool: req.tool,
        });
        if (matched) {
          matchedRuleInstructions = matched.instructions;
          matchedRuleId = matched.id;
        }
      }

      // anchor marker 指令：让 model 在涉及代码位置的内容末尾显式追加
      //   [file: <path>, lines: <start_line>-<end_line>]
      //
      // 主路径已改为 sitecustomize 注入 LocalGitProvider.get_line_link → key_issues 渲染成
      // `[**header**](meebox:///<file>#L<s>-L<e>)`，parse-output 取结构化 anchor（path 来自
      // provider 同源、最可靠）。但 #L 行号仍依赖 model 填了 pr-agent 原生 start_line/
      // end_line YAML 字段；实测部分模型只填这条 marker、留空结构化字段 → 链接只有 path。
      // 故这条 marker 作为**行号兜底**保留：parse-output 合并时链接给 path、缺行号则用 marker
      // 的行号补（resolveIssueAnchor）。两路信号都用上，最大化 anchor 覆盖。
      //
      // 两种工具措辞不同：
      // - /review: 每条 key_issue 末尾 **必加** marker
      // - /ask: 仅当回答涉及具体文件 / 代码位置时 **才加** (自由问答可能完全跟代码
      //   无关 e.g. "PR 概述")，强制会产出假阳性
      //
      // /describe / /improve 不注入：前者不出 issue，后者走 marker 行
      // `[file [start-end]](url)` 自己有 anchor
      const reviewAnchorDirective =
        req.tool === 'review'
          ? [
              'When writing each item under `key_issues_to_review`, append on its OWN LAST LINE',
              'a machine-readable anchor marker in this EXACT format:',
              '',
              '    [file: <relevant_file>, lines: <start_line>-<end_line>]',
              '',
              'Examples:',
              '  [file: src/auth/login.ts, lines: 42-50]',
              '  [file: pkg/cache.go, lines: 17]',
              '',
              'Use the exact relevant_file path and start_line/end_line you already',
              'identified in the YAML output. Do NOT wrap the path in backticks. If you',
              'truly cannot identify a file/line for an issue, omit the marker for that',
              'item only.',
            ].join('\n')
          : req.tool === 'ask'
            ? [
                'CRITICAL: This answer is consumed by a code review GUI that converts your',
                'per-paragraph recommendations into INLINE COMMENTS pinned to specific code',
                'lines. For that to work, EVERY paragraph that names a code symbol (function,',
                'method, class, variable, identifier) from this PR MUST end with a',
                'machine-readable anchor marker on its OWN LAST LINE:',
                '',
                '    [file: <path>, lines: <start_line>-<end_line>]',
                '',
                'Examples:',
                '  [file: src/auth/login.ts, lines: 42-50]',
                '  [file: pkg/cache.go, lines: 17]',
                '  [file: pkg/store.ts]              (path-only fallback; only when you',
                '                                     truly cannot infer any line number)',
                '',
                'How to derive line numbers from the diff:',
                '- Every hunk in the diff begins with a header:',
                '    @@ -<base_start>,<base_count> +<head_start>,<head_count> @@',
                '  The number after `+` is the FIRST head-side line of that hunk. Count down',
                '  through `+` (added) and ` ` (context) lines — DO NOT count `-` (removed)',
                '  lines — to locate the line where the symbol appears. Prefer head-side',
                '  line numbers. For code that ONLY exists on the base side (purely removed),',
                '  use the base-side `-` line number instead.',
                '',
                'Rules — read carefully:',
                '- The marker is REQUIRED. Do not skip it when your paragraph references a',
                '  real code symbol from the diff. A paragraph without a marker becomes',
                '  un-pinnable feedback the user cannot turn into a comment.',
                '- Append exactly ONE marker per paragraph, at the very end of that paragraph,',
                '  on its own line (blank line above it optional but recommended).',
                '- If a paragraph discusses multiple locations, pick the most important one',
                '  (the line where the recommended change should be made).',
                '- Paragraphs that are purely general / conceptual / meta (e.g., overall',
                '  praise, no specific symbol named) MAY omit the marker.',
                '- Use the exact file path from the diff. Do NOT wrap the path in backticks',
                '  or quotes inside the marker.',
                '- If you really cannot pin a line, fall back to path-only `[file: <path>]`',
                '  rather than omitting the marker entirely.',
              ].join('\n')
            : '';

      // 排版指令：只改 /review 每条 key_issue 的断行排版，提升 GUI 可读性，不增加篇幅。
      // pr-agent 原 prompt 要 "short and concise summary"，模型默认堆成单段长跑文；
      // 渲染层 (ReactMarkdown + remarkBreaks) 忠实呈现，空行分段即成独立 <p>。
      // 关键是「保持简洁」——只在现象/影响/建议的语义边界换行，不得借分段扩写内容。
      // 须与上面的 anchor marker 指令协同：分段在正文内部，marker 仍独占最末行。
      const reviewLayoutDirective =
        req.tool === 'review'
          ? [
              'FORMATTING ONLY: Keep each `key_issues_to_review` item as concise as you',
              'already would — do NOT add length, padding, or extra explanation. The only',
              'change is line breaks: instead of one dense run-on paragraph, insert a BLANK',
              'LINE at the natural boundaries (e.g. problem → impact → suggested fix) so the',
              'text reads as a few short paragraphs. Same words, better layout.',
              '',
              'This applies to the issue PROSE only. The machine-readable anchor marker',
              'described above still goes on its OWN LAST LINE, after the final paragraph',
              '(a blank line may precede it).',
            ].join('\n')
          : '';

      const extraParts = [
        langDirective,
        reviewAnchorDirective,
        reviewLayoutDirective,
        prContext,
        matchedRuleInstructions,
      ].filter((s) => s.trim());
      if (extraParts.length > 0) {
        const envKey =
          req.tool === 'describe'
            ? 'PR_DESCRIPTION__EXTRA_INSTRUCTIONS'
            : req.tool === 'review'
              ? 'PR_REVIEWER__EXTRA_INSTRUCTIONS'
              : req.tool === 'improve'
                ? 'PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS'
                : 'PR_QUESTIONS__EXTRA_INSTRUCTIONS';
        env[envKey] = extraParts.join('\n\n---\n\n');
      }
      if (matchedRuleId) {
        logger.info(
          { runId: run.id, ruleId: matchedRuleId, tool: req.tool },
          'pragent run: matched rule',
        );
      }
      if (prContext) {
        logger.debug(
          { runId: run.id, tool: req.tool, contextChars: prContext.length },
          'pragent run: pr context injected',
        );
      }

      // ask 工具：问题作为位置参数（user turn，spawn args 单元素，含空格也是一个 arg 不切分），
      // 并在问题**末尾**硬性追加语言要求。系统侧 CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS 对
      // 自由问答常被大量英文 diff（full diff 数万 token）盖过 → 模型用英文作答；在 user turn 末尾
      // （近因位置、用目标语言书写）再要求一次，显著提升按 UI 语言作答的遵循度。en-US 返回空、不追加。
      const askLangSuffix = req.tool === 'ask' ? askLanguageSuffixFor(getMainLanguage()) : '';
      const askQuestion =
        req.tool === 'ask' && req.question
          ? askLangSuffix
            ? `${req.question}\n\n${askLangSuffix}`
            : req.question
          : undefined;
      const extraArgs = askQuestion ? [askQuestion] : undefined;

      // embedded 策略：执行期在嵌入式安装目录补空 .secrets.toml 压掉启动告警
      // （直接写安装目录；memo 化只首次做）。local-cli 不需要 (pipx 装的 pr-agent
      // 路径不同，告警也不出)
      if (prAgentBridge.strategy === 'embedded' && embeddedPythonPath) {
        await ensureEmbeddedSecrets(embeddedPythonPath);
      }

      const result = await prAgentBridge.run({
        prUrl: pr.url,
        tool: req.tool,
        env,
        onLine,
        cwd: wt.path,
        targetBranch: wt.targetBranchName,
        extraArgs,
        signal: ac.signal,
      });
      // 真实 token 用量（onLine 累加的 stderr 哨兵行），落到 succeeded / llm-failed 收尾。
      const tokenUsage = finalizeUsage(usageAcc);
      // pr-agent 的 local provider 把生成结果**写到工作树根的 markdown 文件**：
      //   /describe → <wt>/description.md  (走 publish_description)
      //   /review   → <wt>/review.md       (走 publish_comment)
      //   /ask      → <wt>/review.md       ← 共用同一文件 (publish_comment 会覆盖)
      //   /improve  → <wt>/improve.md      ← 汇总建议走 publish_comment，经 LOCAL__REVIEW_PATH
      //                                      重定向与 review.md 分流（见上方 env 注入）
      // 走 worktree 路径，cleanup 前必须先把文件读出来。
      const outFile =
        req.tool === 'describe'
          ? 'description.md'
          : req.tool === 'improve'
            ? 'improve.md'
            : 'review.md';
      let fileContent = '';
      try {
        fileContent = await fs.readFile(path.join(wt.path, outFile), 'utf8');
      } catch (readErr) {
        logger.warn(
          { err: readErr, wtPath: wt.path, outFile, runId: run.id },
          'pr-agent local provider output file missing; fall back to stdout',
        );
      }
      // /ask 输出里 pr-agent 把问题原样回显在 answer body 顶部 (跟 chat 输入气泡完全
      // 重复)。在解析前把跟用户问题逐字匹配的整行删掉，避免渲染时出现两次问题
      const cleanedContent =
        req.tool === 'ask' && req.question?.trim()
          ? stripAskQuestionEcho(fileContent, req.question, askLangSuffix)
          : fileContent;
      const parsed = parseReviewOutput(cleanedContent || result.stdout, req.tool);
      // M4 草稿再摄入：/review 成功完成时丢掉 pending+finding 旧草稿，
      // 让本轮 ChatPane 上的 finding 列表成为新的候选源。edited/posted/rejected/
      // manual 保留不动。失败的 /review 不触发清理 (没建设性数据)。
      if (req.tool === 'review') {
        try {
          const dropped = await dropPendingFindingDrafts(stateStore, pr.localId);
          if (dropped > 0) {
            logger.info(
              { runId: run.id, localId: pr.localId, dropped },
              'pragent /review: dropped stale pending drafts',
            );
            broadcast('drafts:changed', { localId: pr.localId });
          }
        } catch (err) {
          logger.warn({ err, runId: run.id }, 'dropPendingFindingDrafts failed');
        }
      }
      // pr-agent CLI 可能 exit 0 但 stdout 里其实是 LLM 调用全失败 (litellm
      // AuthenticationError / "Failed to generate prediction with any model" 等
      // marker)。parseReviewOutput 会在 ParsedReviewOutput.llmFailure 标出 —
      // 此时不算 succeeded，落盘为 failed + reason='llm-error'，UI 用红色失败
      // chip 渲染而不是"完成"
      if (parsed.llmFailure) {
        logger.warn(
          { runId: run.id, reason: parsed.llmFailure.message },
          'pragent exit 0 but LLM call failed; marking run as failed',
        );
        return await finishWith({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: result.exitCode,
          errorReason: 'llm-error',
          errorMessage: parsed.llmFailure.message,
          stdout: fileContent
            ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
            : result.stdout,
          stderr: stripUsageSentinels(result.stderr),
          findings: parsed.findings,
          summary: parsed.summary,
          tokenUsage,
        });
      }
      return await finishWith({
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode: result.exitCode,
        // 持久化「LLM 真实产出」(文件内容)；stdout 留作日志在折叠区供排障
        stdout: fileContent
          ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
          : result.stdout,
        stderr: stripUsageSentinels(result.stderr),
        findings: parsed.findings,
        summary: parsed.summary,
        tokenUsage,
      });
    } catch (err) {
      if (err instanceof PrAgentRunError) {
        // 用户主动取消 → status='cancelled'，其它 reason → 'failed'。
        // 二者都仍走 finishReviewRun 落盘，让 UI 能从历史 run 里看到这次取消事件
        const status: ReviewRunStatus = err.reason === 'cancelled' ? 'cancelled' : 'failed';
        logger.warn(
          { runId: run.id, reason: err.reason, exitCode: err.result.exitCode },
          `pragent run ${status}`,
        );
        // 失败 / 取消时也尽量解析已收集的 stdout：很多情况 pr-agent 已写了一部分输出
        const partialStdout = err.result.stdout ?? '';
        const parsed = partialStdout
          ? parseReviewOutput(partialStdout, req.tool)
          : { findings: [], summary: undefined };
        // 失败 / 取消前可能已有若干次 LLM 调用，尽量把已产生的 token 用量也记上
        const tokenUsage = finalizeUsage(usageAcc);
        return await finishWith({
          status,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: err.result.exitCode,
          errorReason: err.reason,
          errorMessage: err.message,
          stdout: err.result.stdout,
          stderr: stripUsageSentinels(err.result.stderr),
          findings: parsed.findings,
          summary: parsed.summary,
          tokenUsage,
        });
      }
      // 非预期异常：仍记一笔 failed，避免 run 永远卡在 running，再把异常往上抛
      await finishWith({
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await wt.cleanup();
    }
  };

  /**
   * 队列泵：在并发未达上限且 waiting 非空时，连续 dequeue 起跑，直到填满 maxConcurrency。
   * 每条 run 结束（成功/失败/取消）后从 active 移除并再泵一次，自然续上后续任务。
   */
  const pump = (): void => {
    while (active.size < maxConcurrency && waiting.length > 0) {
      const item = waiting.shift()!;
      active.set(item.info.runId, item);
      item.ac = new AbortController();
      void executeRun(item)
        .then((finished) => item.resolve(finished))
        .catch((err: unknown) => {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          active.delete(item.info.runId);
          broadcastQueueChanged();
          // 放微任务里再泵，避免递归栈累积
          queueMicrotask(pump);
        });
    }
    broadcastQueueChanged();
  };

  const enqueuePragentRun = (
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority: RunPriority = 'user',
  ): Promise<ReviewRun> => {
    if (tool !== 'ask') {
      const sameTask = (q: QueueItem): boolean =>
        q.info.prLocalId === pr.localId && q.info.tool === tool;
      if ([...active.values()].some(sameTask) || waiting.some(sameTask)) {
        throw new Error(t('prAgent.duplicateTask', { tool }));
      }
    }
    // 入队时就分配 runId；后续 cancel(runId) 在 waiting / active 都能定位
    const runId = makeRunId(new Date());
    return new Promise<ReviewRun>((resolve, reject) => {
      const item: QueueItem = {
        info: {
          runId,
          prLocalId: pr.localId,
          repoSlug: pr.repo.repoSlug,
          prNumber: pr.remoteId,
          tool,
          question: tool === 'ask' ? question : undefined,
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
        },
        req: { localId: pr.localId, tool, question },
        pr,
        priority,
        resolve,
        reject,
      };
      // 优先级插队：user 任务排到所有 agent 任务之前（同泳道内仍 FIFO）；不打断在跑的 run。
      if (priority === 'user') {
        const firstAgentIdx = waiting.findIndex((q) => q.priority === 'agent');
        if (firstAgentIdx >= 0) waiting.splice(firstAgentIdx, 0, item);
        else waiting.push(item);
      } else {
        waiting.push(item);
      }
      logger.info(
        { runId, localId: pr.localId, tool, priority, queueLen: waiting.length },
        'pragent run enqueued',
      );
      pump();
    });
  };

  const cancel = (runId: string): { ok: boolean } => {
    // active 命中 → SIGKILL (finally 会写 cancelled 到 disk)
    const running = active.get(runId);
    if (running) {
      logger.info({ runId }, 'pragent run cancel: active');
      running.ac?.abort();
      return { ok: true };
    }
    // waiting 命中 → 从队列删除 + reject 原 Promise，不写盘 (从未真正跑过)
    const idx = waiting.findIndex((q) => q.info.runId === runId);
    if (idx >= 0) {
      const [removed] = waiting.splice(idx, 1);
      logger.info({ runId, queueLen: waiting.length }, 'pragent run cancel: queued');
      removed!.reject(new Error('queued run cancelled'));
      broadcastQueueChanged();
      return { ok: true };
    }
    return { ok: false };
  };

  const cancelRunsForPr = (localId: string): void => {
    for (const item of active.values()) if (item.req.localId === localId) item.ac?.abort();
    let removed = false;
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (waiting[i]!.req.localId === localId) {
        const [q] = waiting.splice(i, 1);
        q!.reject(new Error('pr removed'));
        removed = true;
      }
    }
    if (removed) broadcastQueueChanged();
  };

  const queuedPrLocalIds = (): string[] => {
    const ids: string[] = [];
    for (const item of active.values()) ids.push(item.req.localId);
    for (const item of waiting) ids.push(item.req.localId);
    return ids;
  };

  const abortAllActiveRuns = (): number => {
    let n = 0;
    for (const item of active.values()) {
      item.ac?.abort();
      n++;
    }
    return n;
  };

  return {
    enqueuePragentRun,
    cancel,
    snapshot,
    cancelRunsForPr,
    queuedPrLocalIds,
    abortAllActiveRuns,
  };
}

/**
 * 把 config.language (ISO locale) 翻成自然语言 prompt directive，注入到 pr-agent
 * 各 tool 的 EXTRA_INSTRUCTIONS。
 *
 * CONFIG__RESPONSE_LANGUAGE 对 /describe /review 已经够用 (内嵌在它们的 prompt
 * template)，但 /ask 不严格遵守；显式 prompt 强化所有 tool，尤其覆盖 /ask + 表格
 * 类输出的标题 / 列名 / 段落标记。
 *
 * 英文 (en-US) 返回空串，避免给 LLM 加不必要的提示。其他未知 locale 返回空保留
 * pr-agent 原行为。
 */
function languageDirectiveFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return 'Respond in Simplified Chinese (简体中文). All section labels, table headers, column names, headings, and content MUST be in Chinese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return 'Respond in Traditional Chinese (繁體中文). All section labels, table headers, column names, headings, and content MUST be in Chinese.';
  }
  if (norm.startsWith('ja')) {
    return 'Respond in Japanese (日本語). All section labels, table headers, column names, headings, and content MUST be in Japanese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('de')) {
    return 'Respond in German (Deutsch). All section labels, table headers, column names, headings, and content MUST be in German — do not leave any English template strings untranslated.';
  }
  return '';
}

/**
 * /ask 专用：把语言要求作为「问题末尾」的硬性指令，**用目标语言书写本身**（最能促使模型切换到该
 * 语言作答）。系统侧 CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS 对自由问答常被大量英文 diff
 * 盖过，故在 user turn 末尾（近因位置）再要求一次。en-US / 未知 locale 返回空串（默认即英文）。
 */
function askLanguageSuffixFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return '请用简体中文回答整个回复（包括所有解释、说明与结论）。代码、标识符、文件路径保留原样，但所有叙述文字必须是简体中文，不要用英文作答。';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return '請用繁體中文回答整個回覆（包括所有解釋、說明與結論）。程式碼、識別符、檔案路徑保留原樣，但所有敘述文字必須是繁體中文，不要用英文作答。';
  }
  if (norm.startsWith('ja')) {
    return '回答全体を日本語で記述してください（説明・結論を含む）。コード・識別子・ファイルパスはそのまま残し、説明文はすべて日本語にしてください。英語で回答しないでください。';
  }
  if (norm.startsWith('de')) {
    return 'Bitte antworte vollständig auf Deutsch (einschließlich aller Erklärungen und Schlussfolgerungen). Code, Bezeichner und Dateipfade bleiben unverändert, aber der gesamte erläuternde Text muss auf Deutsch sein. Antworte nicht auf Englisch.';
  }
  return '';
}
