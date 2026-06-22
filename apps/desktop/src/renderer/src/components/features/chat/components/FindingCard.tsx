import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { Finding, FindingClosure, PrDocSectionKey, ReviewDraft } from '@meebox/shared';
import { ChevronIcon, mermaidComponents, walkthroughMdComponents } from '../../../common';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { translatePrAgentLabels } from '../../../../utils/translate-pr-agent';
import {
  pillStyle,
  sectionLabel,
  splitTypeLabels,
  stripEffortScoreNumber,
  stripFindingMarker,
} from '../utils/findings';
import { BreakablePath, MdInline } from './shared';

// chip 配色 tone → chat-chip-<tone>（色板见 styles/features/chat/chip.scss）。
// finding 类别：元信息/图/工作量→accent，内容/测试/安全→approved，代码反馈/建议→warning，评分/兜底→neutral。
const CAT_TONE: Record<PrDocSectionKey, 'accent' | 'approved' | 'warning' | 'neutral'> = {
  title: 'accent',
  'pr-type': 'accent',
  diagram: 'accent',
  assessment: 'accent',
  effort: 'accent',
  summary: 'approved',
  description: 'approved',
  walkthrough: 'approved',
  'relevant-tests': 'approved',
  security: 'approved',
  'code-feedback': 'warning',
  'code-suggestion': 'warning',
  // /ask 结构化分段：结论高亮(绿)、建议高亮(琥珀)、过程分析中性(灰，默认收起)
  'ask-summary': 'approved',
  'ask-analysis': 'neutral',
  'ask-suggestions': 'warning',
  score: 'neutral',
  general: 'neutral',
};
// 草稿状态：待处理/已编辑→accent，已发布→approved，已拒绝→neutral
const DRAFT_TONE: Record<NonNullable<ReviewDraft['status']>, 'accent' | 'approved' | 'neutral'> = {
  pending: 'accent',
  edited: 'accent',
  posted: 'approved',
  rejected: 'neutral',
};

/**
 * Finding card 上的草稿状态 chip + 操作按钮。仅代码类 finding（/review code-feedback
 * 与 /improve code-suggestion）+ anchor 完整时出现。
 *
 * 状态可视化：
 * - 无 relatedDraft（用户从未交互）→ 不显示 status chip，只展示"→ 编辑 / ✗ 拒绝"按钮
 * - pending → 蓝 chip "待处理" + 跳转 + 拒绝
 * - edited → 蓝 chip "已编辑" + 跳转 + 拒绝
 * - posted → 绿 chip "已发布" + 跳转 (查看)，无拒绝 (远端已存，本地不该撤销)
 * - rejected → 灰 chip "已拒绝" + 撤销 (即重新跳转编辑)
 */
function FindingDraftActions({
  relatedDraft,
  onJump,
  onReject,
  onReference,
  closure,
  onReopen,
  onViewAsk,
}: {
  relatedDraft?: ReviewDraft;
  onJump?: () => void;
  onReject?: () => void;
  /** 「引用」按钮回调：把本 finding 挂到输入栏发起复评 /ask。 */
  onReference?: () => void;
  /** 已被复评关闭/取代时的关闭关系；存在则展示关闭态（替代草稿动作）。 */
  closure?: FindingClosure;
  /** 「撤销关闭」回调。 */
  onReopen?: () => void;
  /** 「查看复评」回调：滚动定位到关闭它的复评 /ask 卡片。 */
  onViewAsk?: () => void;
}) {
  const { t } = useTranslation();
  // 已被复评关闭/取代：展示关闭 chip + 查看复评 + 撤销关闭，替代常规草稿动作。
  if (closure) {
    return (
      <div className="chat-finding-draft-actions">
        <span className="chat-chip chat-chip-tight chat-chip-neutral chat-finding-closed-chip">
          {closure.verdict === 'replace'
            ? t('chatPane.reference.closedReplaced')
            : t('chatPane.reference.closedDropped')}
        </span>
        {onViewAsk && (
          <button type="button" className="chat-finding-draft-btn" onClick={onViewAsk}>
            {t('chatPane.reference.viewAsk')}
          </button>
        )}
        {onReopen && (
          <button type="button" className="chat-finding-draft-btn" onClick={onReopen}>
            {t('chatPane.reference.reopen')}
          </button>
        )}
      </div>
    );
  }
  const status = relatedDraft?.status;
  const chipText: Record<NonNullable<typeof status>, string> = {
    pending: t('chatPane.draftStatusPending'),
    edited: t('chatPane.draftStatusEdited'),
    posted: t('chatPane.draftStatusPosted'),
    rejected: t('chatPane.draftStatusRejected'),
  };
  return (
    <div className="chat-finding-draft-actions">
      {status && (
        <span
          className={`chat-chip chat-chip-tight chat-chip-${DRAFT_TONE[status]}${
            status === 'rejected' ? ' chat-finding-draft-chip-rejected' : ''
          }`}
        >
          {chipText[status]}
        </span>
      )}
      {/* posted 后跳转只是"查看"语义，不再有编辑动作；rejected 跳转即"撤销并继续编辑" */}
      {onJump && (
        <button
          type="button"
          className="chat-finding-draft-btn"
          onClick={onJump}
          title={
            status === 'posted'
              ? t('chatPane.draftJumpViewTitle')
              : status === 'rejected'
                ? t('chatPane.draftJumpRestoreTitle')
                : t('chatPane.draftJumpEditTitle')
          }
        >
          {status === 'posted'
            ? t('chatPane.draftJumpView')
            : status === 'rejected'
              ? t('chatPane.draftJumpRestore')
              : t('common.edit')}
        </button>
      )}
      {/* posted 不允许 reject (远端已存)；rejected 也不允许 reject (已经是了) */}
      {onReject && status !== 'posted' && status !== 'rejected' && (
        <button
          type="button"
          className="chat-finding-draft-btn chat-finding-draft-btn-reject"
          onClick={onReject}
          title={t('chatPane.rejectFindingTitle')}
        >
          {t('chatPane.reject')}
        </button>
      )}
      {/* 引用：把本条评论挂到输入栏发起复评 /ask（出裁决 + 采纳/关闭动作）。posted 后不再引用。 */}
      {onReference && status !== 'posted' && (
        <button
          type="button"
          className="chat-finding-draft-btn"
          onClick={onReference}
          title={t('chatPane.reference.referenceTitle')}
        >
          {t('chatPane.reference.reference')}
        </button>
      )}
    </div>
  );
}

export function FindingCard({
  finding,
  relatedDraft,
  onJump,
  onReject,
  onNavigate,
  onReference,
  closure,
  onReopen,
  onViewAsk,
}: {
  finding: Finding;
  /** 该 finding 关联的草稿；undefined = 尚未交互过；不为空 = 已 pending / edited / rejected / posted */
  relatedDraft?: ReviewDraft;
  /** 「→ 跳到代码编辑」按钮回调 */
  onJump?: () => void;
  /** 「✗ 拒绝」按钮回调 */
  onReject?: () => void;
  /** 点击锚点：仅导航到 Diff 对应行（不进编辑态） */
  onNavigate?: () => void;
  /** 「引用」按钮回调：把本 finding 挂到输入栏发起复评 /ask（仅 code 类 finding 出现）。 */
  onReference?: () => void;
  /** 本 finding 已被复评关闭/取代时的关闭关系（驱动关闭态渲染）。 */
  closure?: FindingClosure;
  /** 「撤销关闭」回调。 */
  onReopen?: () => void;
  /** 「查看复评」回调：滚动定位到关闭它的复评 /ask 卡片。 */
  onViewAsk?: () => void;
}) {
  const { t } = useTranslation();
  // 已拒绝：左色条 + 类别 chip 置灰，卡片默认折叠收起（仅留头部 chip + 锚点行 +
  // 撤销按钮）。点头部的展开/收起切换可临时回看正文，不影响草稿状态。
  const isRejected = relatedDraft?.status === 'rejected';
  // 已被复评关闭/取代：同样收起降饱和（与已拒绝同套视觉），动作区改为查看复评 + 撤销关闭。
  const isClosed = !!closure;
  // sectionKey 优先（新解析的），fallback 到 category (旧持久化的 run)
  const key: PrDocSectionKey = finding.sectionKey ?? 'general';
  // 默认折叠：已拒绝 / 已关闭 finding，或 /ask「分析过程」段（过程性讨论默认收起、可展开，复用同套折叠 UI）。
  const collapsibleByDefault = isRejected || isClosed || key === 'ask-analysis';
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsibleByDefault && !expanded;
  const label = sectionLabel(key, t);
  // 标题在已知 sectionKey 上**通常**跟 chip label 内容重复 (h4 显示 "PR Type" + chip
  // 显示 "类型")，所以默认只有 general 段才出 title。但 pr-agent 把若干段的"值"放在
  // 标题里 (e.g., `Estimated effort to review: 3 🔵🔵🔵⚪⚪` / `Score: 85 🟢🟢...`)，
  // body 是空的；这种情况强制把 title 渲染出来，否则卡片只剩 chip 一片空白。
  // 先剥 [file:...] 末尾 marker (pr-agent /review 的 anchor 注入用，用户不可见)
  // 再走 pr-agent 模板翻译。bodyEmpty 也按 stripped 后判断
  const strippedBody = stripFindingMarker(finding.body);
  const bodyEmpty = !strippedBody.trim();
  const showTitle = !!finding.title && (key === 'general' || bodyEmpty);
  // pr-agent 把若干 section 标题 / 固定模板字符串硬编码成英文 (CONFIG__RESPONSE_LANGUAGE
  // 只翻译 LLM 内容值)，渲染前替换成中文。工作量已用 emoji 圆点表分值，去掉冗余的数字分数。
  const translatedBody =
    key === 'effort'
      ? stripEffortScoreNumber(translatePrAgentLabels(strippedBody))
      : translatePrAgentLabels(strippedBody);
  const translatedTitle = finding.title
    ? key === 'effort'
      ? stripEffortScoreNumber(translatePrAgentLabels(finding.title))
      : translatePrAgentLabels(finding.title)
    : undefined;
  return (
    <li
      className={`chat-finding chat-finding-${key}${isRejected || isClosed ? ' chat-finding-rejected' : ''}${collapsed ? ' chat-finding-collapsed' : ''}`}
    >
      <header className="chat-finding-head">
        {/* 已知 sectionKey 用中文标签 chip；general / 未知不显示，避免 UI 噪音 */}
        {label && (
          <span className={`chat-chip chat-chip-md chat-finding-cat chat-chip-${CAT_TONE[key]}`}>
            {label}
          </span>
        )}
        {/* PR Type 段：值胶囊与「类型」标签同排、右对齐（不再上下两排，提升空间利用率） */}
        {key === 'pr-type' && (
          <div className="chat-finding-pills chat-finding-pills-inline">
            {splitTypeLabels(translatedBody).map((t) => (
              <span key={t} className="pr-type-pill" style={pillStyle(t)}>
                {t}
              </span>
            ))}
          </div>
        )}
        {showTitle && translatedTitle && !collapsed && (
          <h4 className="chat-finding-title">
            <MdInline>{translatedTitle}</MdInline>
          </h4>
        )}
        {/* 可默认折叠的段（已拒绝 / ask 分析过程）出现展开 / 收起切换：chevron 收起态指右、展开态转下 */}
        {collapsibleByDefault && (
          <button
            type="button"
            className={`chat-finding-collapse-toggle${collapsed ? '' : ' is-expanded'}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={!collapsed}
          >
            <ChevronIcon />
          </button>
        )}
      </header>
      {finding.anchor && (
        <div className="chat-finding-anchor muted">
          {finding.anchor.startLine !== undefined && onNavigate ? (
            // 可点击：跳转到 Diff 对应行（scroll+highlight，不进编辑态）
            <button
              type="button"
              className="chat-finding-anchor-link"
              onClick={onNavigate}
              title={t('chatPane.anchorJumpTitle')}
            >
              <code>
                <BreakablePath path={finding.anchor.path} />
              </code>
              <span>
                :{finding.anchor.startLine}
                {finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine
                  ? `-${String(finding.anchor.endLine)}`
                  : ''}
              </span>
            </button>
          ) : (
            <>
              <code>
                <BreakablePath path={finding.anchor.path} />
              </code>
              {finding.anchor.startLine && (
                <span>
                  :{finding.anchor.startLine}
                  {finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine
                    ? `-${String(finding.anchor.endLine)}`
                    : ''}
                </span>
              )}
            </>
          )}
          {/* /improve 建议带的 1-10 重要度评分；高分加 warning 着色提示 reviewer */}
          {typeof finding.score === 'number' && (
            <span
              className={`chat-finding-score${finding.score >= 8 ? ' chat-finding-score-high' : ''}`}
              title={t('chatPane.scoreTitle')}
            >
              {finding.score}/10
            </span>
          )}
          {/* M4 草稿状态 chip + 操作按钮：锚到具体行的代码类 finding 才展示——
              /review 的 code-feedback 与 /improve 的 code-suggestion 同享这套
              「编辑转草稿 → 发布行内评论」交互（其它如 summary / description /
              score 没法变 inline 评论） */}
          {finding.anchor.startLine !== undefined &&
            (onJump || onReject || onReference || isClosed) &&
            (key === 'code-feedback' || key === 'code-suggestion') && (
              <FindingDraftActions
                relatedDraft={relatedDraft}
                onJump={onJump}
                onReject={onReject}
                onReference={onReference}
                closure={closure}
                onReopen={onReopen}
                onViewAsk={onViewAsk}
              />
            )}
        </div>
      )}
      {/* 已拒绝折叠态隐藏正文与代码对比，只留头部 chip + 锚点行 + 撤销入口。
          pr-type 的值胶囊已并入头部行（见上），此处不再单独成段。 */}
      {!collapsed && key !== 'pr-type' && (
        <div className="chat-finding-body markdown">
          {/* remarkBreaks 把 finding body 里的单换行也当成 <br>。pr-agent 的 trace、
              或一般段落里 reviewer 习惯按软换行折行，不加 remarkBreaks 会被 markdown
              合并成长一行。Findings 主要是富文本说明，不存在"故意软换行连接"的场景 */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={REMOTE_REHYPE_PLUGINS}
            // 「文件变更」walkthrough 用去掉 <details open> 的覆盖，使各文件分类默认折叠收起。
            components={key === 'walkthrough' ? walkthroughMdComponents : mermaidComponents}
          >
            {translatedBody}
          </ReactMarkdown>
        </div>
      )}
      {/* /improve 给的 existing → improved 代码对比。两段都是片段，独立 <pre> 块
          + 红/绿背景 模拟 diff 视觉 (不用 Monaco DiffEditor 节省开销) */}
      {!collapsed && finding.codeChange && (
        <div className="chat-finding-code-change">
          {finding.codeChange.existing && (
            <pre
              className="chat-finding-code-change-block chat-finding-code-change-existing"
              aria-label={t('chatPane.codeExistingAria')}
            >
              {finding.codeChange.existing}
            </pre>
          )}
          {finding.codeChange.improved && (
            <pre
              className="chat-finding-code-change-block chat-finding-code-change-improved"
              aria-label={t('chatPane.codeImprovedAria')}
            >
              {finding.codeChange.improved}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
