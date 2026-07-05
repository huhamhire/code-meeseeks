import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { Finding, FindingClosure, PrDocSectionKey, ReviewDraft } from '@meebox/shared';
import {
  BanIcon,
  ChevronIcon,
  CommentIcon,
  ShareIcon,
  mermaidComponents,
  walkthroughMdComponents,
} from '../../../common';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { translatePrAgentLabels } from '../../../../utils/translate-pr-agent';
import {
  pillStyle,
  sectionLabel,
  splitTypeLabels,
  stripEffortScoreNumber,
  stripFindingMarker,
} from '../utils/findings';
import { BreakablePath, MdInline, withInlineSummary } from './shared';

// Collapsible titles (<details><summary>) support inline markdown: `code` / **emphasis** etc. in the suggestion option titles take effect.
// Budgeted at module level to avoid rebuilding the components object on every render.
const DEFAULT_MD_COMPONENTS = withInlineSummary(mermaidComponents);
const WALKTHROUGH_MD_COMPONENTS = withInlineSummary(walkthroughMdComponents);

// chip color tone → chat-chip-<tone> (palette see styles/features/chat/chip.scss).
// finding categories: meta-info/diagram/effort→accent, content/tests/security→approved, code-feedback/suggestion→warning, score/fallback→neutral.
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
  // /ask structured segments: conclusion highlight (green), suggestion highlight (amber), process analysis neutral (grey, collapsed by default)
  'ask-summary': 'approved',
  'ask-analysis': 'neutral',
  'ask-suggestions': 'warning',
  score: 'neutral',
  general: 'neutral',
};
// Draft status: pending/edited→accent, posted→approved, rejected→neutral
const DRAFT_TONE: Record<NonNullable<ReviewDraft['status']>, 'accent' | 'approved' | 'neutral'> = {
  pending: 'accent',
  edited: 'accent',
  posted: 'approved',
  rejected: 'neutral',
};

/**
 * The action icon bar in the top-right of the Finding card header: edit (comment bubble) / reject (circular ban) + reference (forward arrow).
 * Appears only for code-type findings (/review code-feedback and /improve code-suggestion) + complete anchor, not closed,
 * ordered to the left of the collapse chevron. The edit action switches semantics with draft status (edit / view / undo); posted / rejected do not show reject.
 */
function FindingHeadActions({
  relatedDraft,
  onJump,
  onReject,
  onReference,
}: {
  relatedDraft?: ReviewDraft;
  onJump?: () => void;
  onReject?: () => void;
  onReference?: () => void;
}) {
  const { t } = useTranslation();
  const status = relatedDraft?.status;
  // posted (already exists on the remote, not undone) / rejected (already in the rejected state) do not show the reject button.
  const canReject = status !== 'posted' && status !== 'rejected';
  return (
    <div className="chat-finding-head-actions">
      {/* Edit→comment draft. For posted, jumping means "view"; for rejected, jumping means "undo and keep editing". */}
      {onJump && (
        <button
          type="button"
          className="chat-finding-head-btn"
          onClick={onJump}
          title={
            status === 'posted'
              ? t('chatPane.draftJumpViewTitle')
              : status === 'rejected'
                ? t('chatPane.draftJumpRestoreTitle')
                : t('chatPane.draftJumpEditTitle')
          }
          aria-label={
            status === 'posted'
              ? t('chatPane.draftJumpView')
              : status === 'rejected'
                ? t('chatPane.draftJumpRestore')
                : t('common.edit')
          }
        >
          <CommentIcon size={16} />
        </button>
      )}
      {onReject && canReject && (
        <button
          type="button"
          className="chat-finding-head-btn chat-finding-head-btn-reject"
          onClick={onReject}
          title={t('chatPane.rejectFindingTitle')}
          aria-label={t('chatPane.reject')}
        >
          <BanIcon size={16} />
        </button>
      )}
      {/* Reference: initiate a re-review /ask (attached to the input bar), social-media "forward" arrow icon, ordered to the right of edit / reject. */}
      {onReference && (
        <button
          type="button"
          className="chat-finding-reference-btn"
          onClick={onReference}
          title={t('chatPane.reference.referenceTitle')}
          aria-label={t('chatPane.reference.reference')}
        >
          <ShareIcon size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * Status display to the right of the Finding card's anchor row. Appears only for code-type findings (/review
 * code-feedback and /improve code-suggestion) + complete anchor. The action buttons have been moved up to the
 * header icon bar (see FindingHeadActions), so this only carries **status**: a read-only closed chip when auto-closed
 * by a re-review verdict of replace/drop (+ "view re-review" navigation, no user operations like undo/close — closing
 * is driven by the backend ask task), otherwise the draft status chip (pending / edited / posted / rejected).
 */
function FindingDraftActions({
  relatedDraft,
  closure,
  onViewAsk,
}: {
  relatedDraft?: ReviewDraft;
  /** The closure relationship when auto-closed/replaced by a re-review verdict (drives read-only display). */
  closure?: FindingClosure;
  /** "View re-review" navigation callback: scroll to and locate the re-review /ask card that closed it (read-only navigation, not a close operation). */
  onViewAsk?: () => void;
}) {
  const { t } = useTranslation();
  // Already replaced/closed by a re-review: read-only chip (+ view re-review navigation). Closing is driven by the backend ask verdict, no undo button is provided.
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
      </div>
    );
  }
  const status = relatedDraft?.status;
  if (!status) return null;
  const chipText: Record<NonNullable<typeof status>, string> = {
    pending: t('chatPane.draftStatusPending'),
    edited: t('chatPane.draftStatusEdited'),
    posted: t('chatPane.draftStatusPosted'),
    rejected: t('chatPane.draftStatusRejected'),
  };
  return (
    <div className="chat-finding-draft-actions">
      <span
        className={`chat-chip chat-chip-tight chat-chip-${DRAFT_TONE[status]}${
          status === 'rejected' ? ' chat-finding-draft-chip-rejected' : ''
        }`}
      >
        {chipText[status]}
      </span>
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
  onViewAsk,
}: {
  finding: Finding;
  /** The draft associated with this finding; undefined = not interacted with yet; non-null = already pending / edited / rejected / posted */
  relatedDraft?: ReviewDraft;
  /** "→ Jump to code editing" button callback */
  onJump?: () => void;
  /** "✗ Reject" button callback */
  onReject?: () => void;
  /** Click the anchor: only navigate to the corresponding Diff line (does not enter edit state) */
  onNavigate?: () => void;
  /** "Reference" button callback: attaches this finding to the input bar to initiate a re-review /ask (only appears for code-type findings). */
  onReference?: () => void;
  /** The closure relationship when this finding is auto-closed by a re-review verdict of replace/drop (drives read-only display). */
  closure?: FindingClosure;
  /** "View re-review" navigation callback: scroll to and locate the re-review /ask card that closed it. */
  onViewAsk?: () => void;
}) {
  const { t } = useTranslation();
  // Rejected: left color bar + category chip greyed out, card collapsed by default (only the header chip + anchor row remain). Clicking the
  // header's expand/collapse toggle can temporarily review the body without affecting the draft status.
  const isRejected = relatedDraft?.status === 'rejected';
  // Replaced/closed by a re-review: likewise collapsed and desaturated (same visual as rejected), the anchor row shows a read-only closed chip.
  const isClosed = !!closure;
  // sectionKey takes priority (newly parsed), fallback to category (from an older persisted run)
  const key: PrDocSectionKey = finding.sectionKey ?? 'general';
  // Actionable code-type findings (/review code-feedback, /improve code-suggestion with an anchor line number):
  // only these show the header edit / reject / reference icon bar + the anchor row's draft status / closed state.
  const isActionableCode =
    (key === 'code-feedback' || key === 'code-suggestion') &&
    finding.anchor?.startLine !== undefined;
  // Collapsed by default: rejected / re-review-closed findings, or the /ask "analysis process" segment (process discussion collapsed by default, expandable).
  const collapsibleByDefault = isRejected || isClosed || key === 'ask-analysis';
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsibleByDefault && !expanded;
  const label = sectionLabel(key, t);
  // On a known sectionKey the title **usually** duplicates the chip label content (h4 shows "PR Type" + chip
  // shows "类型"), so by default only the general segment shows the title. But pr-agent puts some segments' "values"
  // in the title (e.g., `Estimated effort to review: 3 🔵🔵🔵⚪⚪` / `Score: 85 🟢🟢...`),
  // with an empty body; in this case force the title to render, otherwise the card is left with just the chip and blank space.
  // First strip the trailing [file:...] marker (used for pr-agent /review's anchor injection, invisible to the user)
  // then run pr-agent template translation. bodyEmpty is also judged after stripping
  const strippedBody = stripFindingMarker(finding.body);
  const bodyEmpty = !strippedBody.trim();
  const showTitle = !!finding.title && (key === 'general' || bodyEmpty);
  // pr-agent hard-codes some section titles / fixed template strings in English (CONFIG__RESPONSE_LANGUAGE
  // only translates LLM content values), replaced with Chinese before rendering. Effort already uses emoji dots for the score value, so drop the redundant numeric score.
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
      // data-finding-id: lets the reference badge at the top of the re-review card, when clicked, precisely locate this original finding card within the original run and flash-highlight it.
      data-finding-id={finding.id}
      className={`chat-finding chat-finding-${key}${isRejected || isClosed ? ' chat-finding-rejected' : ''}${collapsed ? ' chat-finding-collapsed' : ''}`}
    >
      <header
        className={`chat-finding-head${collapsibleByDefault ? ' chat-finding-head-toggle' : ''}`}
        // Collapsible cards (analysis process / rejected / re-review-closed code feedback): the whole title row is the expand/collapse hot zone, enlarging the clickable area.
        // Ignore clicks from inner buttons (edit/reject/reference/chevron) — they handle themselves and should not accidentally trigger collapse (the chevron's
        // click bubbles through here, its own onClick handles it once, so skip directly when closest('button') hits).
        onClick={
          collapsibleByDefault
            ? (e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                setExpanded((v) => !v);
              }
            : undefined
        }
      >
        {/* Known sectionKey uses a Chinese label chip; general / unknown are not shown, avoiding UI noise */}
        {label && (
          <span className={`chat-chip chat-chip-md chat-finding-cat chat-chip-${CAT_TONE[key]}`}>
            {label}
          </span>
        )}
        {/* PR Type segment: value pills on the same row as the "type" label, right-aligned (no longer two stacked rows, improving space utilization) */}
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
        {/* Header action icon bar: edit (comment) / reject (circular ban) / reference (forward arrow). Appears only for anchorable code-type
            findings not closed by a re-review, ordered to the left of the collapse chevron; on the same row as the title, grouped in the top-right. */}
        {isActionableCode && !isClosed && (onJump || onReject || onReference) && (
          <FindingHeadActions
            relatedDraft={relatedDraft}
            onJump={onJump}
            onReject={onReject}
            onReference={onReference}
          />
        )}
        {/* Segments collapsible by default (rejected / ask analysis process) get an expand / collapse toggle: chevron points right when collapsed, turns down when expanded */}
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
            // Clickable: jump to the corresponding Diff line (scroll+highlight, does not enter edit state)
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
          {/* The 1-10 importance score carried by /improve suggestions; high scores get warning coloring to alert the reviewer */}
          {typeof finding.score === 'number' && (
            <span
              className={`chat-finding-score${finding.score >= 8 ? ' chat-finding-score-high' : ''}`}
              title={t('chatPane.scoreTitle')}
            >
              {finding.score}/10
            </span>
          )}
          {/* M4 draft status chip / re-review closed state: only shown for code-type findings anchored to a specific line (action buttons
              have been moved up to the header icon bar). Appears only when there is a draft status or it is closed by a re-review, otherwise takes no space. */}
          {isActionableCode && (isClosed || relatedDraft?.status) && (
            <FindingDraftActions
              relatedDraft={relatedDraft}
              closure={closure}
              onViewAsk={onViewAsk}
            />
          )}
        </div>
      )}
      {/* Collapsible content (body + code comparison): grid-rows 0fr↔1fr for smooth collapse/expand (auto height can be animated). Content is always mounted,
          collapsed by CSS via .chat-finding-collapsed with inner overflow:hidden clipping — hence the height transition animation on collapse/expand.
          pr-type's value pills have been merged into the header row, no body segment; when there is no codeChange the whole thing does not render. */}
      {(key !== 'pr-type' || finding.codeChange) && (
        <div className="chat-finding-collapsible">
          <div className="chat-finding-collapsible-inner">
            {key !== 'pr-type' && (
              <div className="chat-finding-body markdown">
                {/* remarkBreaks treats single line breaks in the finding body as <br> too. In pr-agent's trace,
                    or in general paragraphs where reviewers habitually wrap by soft line breaks, without remarkBreaks markdown
                    would merge them into one long line. Findings are mainly rich-text descriptions, there is no "deliberate soft-break joining" scenario */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  rehypePlugins={REMOTE_REHYPE_PLUGINS}
                  // The "file changes" walkthrough uses an override without <details open>, so each file category is collapsed by default.
                  // Both sets add "<summary> inline markdown" on top (collapsible titles support preformatting like `code`).
                  components={key === 'walkthrough' ? WALKTHROUGH_MD_COMPONENTS : DEFAULT_MD_COMPONENTS}
                >
                  {translatedBody}
                </ReactMarkdown>
              </div>
            )}
            {/* The existing → improved code comparison given by /improve. Both are fragments, independent <pre> blocks
                + red/green background to mimic the diff visual (not using Monaco DiffEditor, saving overhead) */}
            {finding.codeChange && (
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
          </div>
        </div>
      )}
    </li>
  );
}
