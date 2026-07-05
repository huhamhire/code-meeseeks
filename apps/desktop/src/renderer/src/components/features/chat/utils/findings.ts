import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { DEFAULT_CODE_SUGGESTION_LAYOUT, type Finding, type PrDocSectionKey } from '@meebox/shared';

/**
 * The issue body from pr-agent /review has a trailing `[file: <path>, lines: <s>-<e>]`
 * marker — injected by our prompt directive so the parser can extract the anchor, meaningless to users.
 * Cleaned uniformly before FindingCard renders / when converting to draft
 */
export function stripFindingMarker(body: string): string {
  // The path may contain `[]`: with lines, use lazy `.+?` + the required `, lines:` suffix to delimit (`.` matches `]`, so it isn't
  // truncated by a `]` in the path); without lines, fall back to the old style that excludes `]`. Anchored at the end, only strips the trailing marker.
  return body
    .replace(
      /\s*\[\s*file\s*:\s*(?:.+?\s*,\s*lines?\s*:\s*\d+(?:\s*[-–—]\s*\d+)?|[^\]\n]*?)\s*\]\s*$/i,
      '',
    )
    .trimEnd();
}

/**
 * Normalize inline HTML tags in pr-agent GFM output into markdown. Finding cards use ReactMarkdown
 * (HTML allowed) which renders these tags fine, but once converted to draft body landing in the editor textarea / published to the remote,
 * bare `<code>` `<br>` aren't necessarily rendered and get exposed as literal tags. Here we convert common inline tags to equivalent
 * markdown: `<code>x</code>`→`` `x` ``, `<br>`→newline, `<b>/<strong>`→`**`, `<i>/<em>`→`*`.
 * Empty `<code></code>` is simply dropped to avoid producing isolated empty backticks.
 */
export function htmlInlineToMarkdown(text: string): string {
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, (_, inner: string) =>
      inner.trim() ? `\`${inner}\`` : '',
    )
    .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, '*$1*');
}

/**
 * Render an AI code-suggestion finding into a review draft body, applying the user's deterministic layout template
 * (settings → agent.strategy.code_suggestion_layout). The author controls the whole comment layout (line breaks,
 * sections, extra content). Placeholders (uppercase, angle-bracketed):
 *   `<TITLE>`       — localized "AI suggestion" label
 *   `<SUGGESTIONS>` — the (already cleaned) suggestion body
 *   `<HOME>`        — project site url
 *   `<PR>`          — current PR url
 *   `<MODEL>`       — current active model name (empty when unknown), e.g. for an attribution suffix
 * If the template contains `<SUGGESTIONS>` it is used as a full body template (the author places the body); otherwise
 * the whole string is prepended as a prefix before the body. An empty template falls back to
 * `DEFAULT_CODE_SUGGESTION_LAYOUT`. All substitution is deterministic — no dependency on model compliance.
 */
export function renderCodeSuggestionDraft(input: {
  template: string;
  /** The already-cleaned suggestion body (stripFindingMarker + htmlInlineToMarkdown applied by the caller). */
  body: string;
  /** Localized "AI suggestion" label for `<TITLE>`. */
  title: string;
  homeUrl: string;
  prUrl: string;
  /** Current active model name for `<MODEL>` (empty string when unknown). */
  modelName: string;
}): string {
  const tpl = input.template.trim() || DEFAULT_CODE_SUGGESTION_LAYOUT;
  const filled = tpl
    .replaceAll('<TITLE>', input.title)
    .replaceAll('<HOME>', input.homeUrl)
    .replaceAll('<PR>', input.prUrl)
    .replaceAll('<MODEL>', input.modelName)
    .replaceAll('<SUGGESTIONS>', input.body);
  // Contains the body placeholder → full body template; otherwise treat as a prefix and append the body after it.
  return tpl.includes('<SUGGESTIONS>') ? filled : `${filled}\n\n${input.body}`;
}

/**
 * sectionKey → label + render order. Arranges pr-agent output by known sections into a standard document skeleton:
 *   suggested title → type → summary → description → walkthrough → tests → security → code feedback → effort → score → other
 * Unrecognized (sectionKey === undefined or 'general') goes through the fallback, placed at the end in parse order.
 */
const SECTION_ORDER: Record<PrDocSectionKey, number> = {
  title: 0,
  'pr-type': 1,
  summary: 2,
  description: 3,
  diagram: 4,
  assessment: 5, // assessment follows the diagram (aligned with Qodo: Description → Diagram → Assessment)
  walkthrough: 6,
  'relevant-tests': 7,
  security: 8,
  'code-feedback': 9,
  'code-suggestion': 9, // grouped with code-feedback, no ordering preference between them in the UI
  effort: 10,
  score: 11,
  general: 12,
  // /ask structured sections (only appear within an /ask run, relative order among them: summary → analysis → suggestions)
  'ask-summary': 13,
  'ask-analysis': 14,
  'ask-suggestions': 15,
};
const SECTION_LABEL_KEY: Record<PrDocSectionKey, string | null> = {
  title: 'chatPane.sectionTitle',
  'pr-type': 'chatPane.sectionPrType',
  summary: 'chatPane.sectionSummary',
  description: 'chatPane.sectionDescription',
  diagram: 'chatPane.sectionDiagram',
  assessment: 'chatPane.sectionAssessment',
  walkthrough: 'chatPane.sectionWalkthrough',
  'relevant-tests': 'chatPane.sectionRelevantTests',
  security: 'chatPane.sectionSecurity',
  'code-feedback': 'chatPane.sectionCodeFeedback',
  'code-suggestion': 'chatPane.sectionCodeSuggestion',
  effort: 'chatPane.sectionEffort',
  score: 'chatPane.sectionScore',
  general: null, // general / unknown sections have no chip label
  'ask-summary': 'chatPane.sectionAskSummary',
  'ask-analysis': 'chatPane.sectionAskAnalysis',
  'ask-suggestions': 'chatPane.sectionAskSuggestions',
};
export function sectionLabel(key: PrDocSectionKey, t: TFunction): string {
  const k = SECTION_LABEL_KEY[key];
  return k ? t(k) : '';
}

/**
 * The effort section already uses emoji dots (🔵🔵🔵⚪⚪) to intuitively represent a 1-5 score, so drop the redundant leading numeric score:
 *   "3 🔵🔵🔵⚪⚪" → "🔵🔵🔵⚪⚪"; "Effort: 3 🔵🔵" → "Effort: 🔵🔵"
 * Only strips when the number is immediately followed by a dot emoji, to avoid removing ordinary numbers in the body.
 */
export function stripEffortScoreNumber(s: string): string {
  return s.replace(/(^|[:：]\s*)\d+\s*(?=[🔵⚪⚫🟢🔴🟠🟡🟣🟤])/u, '$1');
}

/**
 * Stable sort by sectionKey + preserve original order within the same key (compatible with JS engines where Array.sort isn't stable).
 * The effort section is filtered out entirely: "Estimated effort to review" has low practical value, not shown.
 */
export function orderFindings(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.sectionKey !== 'effort')
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ka = SECTION_ORDER[a.f.sectionKey ?? 'general'] ?? 99;
      const kb = SECTION_ORDER[b.f.sectionKey ?? 'general'] ?? 99;
      return ka === kb ? a.i - b.i : ka - kb;
    })
    .map((x) => x.f);
}

/** Anchor short label `<basename>:<startLine>` (used by re-review badges / reference chips), returns empty string when there's no anchor. */
export function anchorShortLabel(anchor?: {
  path: string;
  startLine?: number;
  endLine?: number;
}): string {
  if (!anchor) return '';
  const base = anchor.path.split('/').pop() ?? anchor.path;
  return anchor.startLine ? `${base}:${String(anchor.startLine)}` : base;
}

/**
 * Assemble a finding pending re-review into /ask's implicit reference context (referencedContext): let the model see the original comment body + location,
 * and re-review accordingly. Like the diff selection reference (formatReferencedContext), it's injected via EXTRA_INSTRUCTIONS, not into the question position args.
 */
export function formatFindingReference(finding: Finding): string {
  const a = finding.anchor;
  const loc = a
    ? ` on \`${a.path}\`${
        a.startLine
          ? ` (L${String(a.startLine)}${
              a.endLine && a.endLine !== a.startLine ? `-L${String(a.endLine)}` : ''
            })`
          : ''
      }`
    : '';
  return `An existing review comment${loc} is being re-evaluated:\n\n${stripFindingMarker(finding.body)}`;
}

/**
 * String → HSL hue. Simplified djb2, stable → the same label is always the same color. Used for PR Type pill
 * auto-coloring ("Bug fix" / "Enhancement" / "Tests" each get a different color, no need for a hardcoded dictionary).
 */
function labelHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
export function pillStyle(s: string): CSSProperties {
  // Only inject the label hue (--pill-hue); saturation / lightness for the light and dark sets are decided by CSS per theme (see .pr-type-pill) —
  // avoids hardcoding a dark HSL in JS (background L=22%) that would make pills too dark and jarring in the light theme.
  return { ['--pill-hue']: labelHue(s) } as CSSProperties;
}
/**
 * Split "Bug fix, Enhancement\nTests" into ["Bug fix", "Enhancement", "Tests"].
 * The parser layer already stripped HRs; add another defensive layer here: filter out pure-punctuation / length ≤1 items
 * to keep markdown decoration symbols out of the pills ("---" has actually been seen)
 */
export function splitTypeLabels(body: string): string[] {
  return body
    .split(/[,\n]/)
    .map((s) => s.replace(/^[\s\-*_·•]+|[\s\-*_·•.]+$/g, '').trim())
    .filter((s) => s.length > 1 && !/^[\s\-*_·•.]+$/.test(s));
}
