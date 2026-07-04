import type { AgentRecommendation, AgentRecommendationVerdict, Finding } from '@meebox/shared';
import { VERDICTS } from '../../constants.js';
import type {
  AgentStepLabels,
  ReviewOrchestratorDeps,
  ReviewOrchestratorInput,
  ToolText,
} from '../../orchestrator.js';
import { PROMPT_TEMPLATES } from '../../prompts.js';
import { fillTemplate } from '../../utils/index.js';
import type { StepRecorder } from '../context.js';

/**
 * Shared pieces for the review micro-flow steps: cross-step context / accumulator + judge / summary prompts and verdict parsing. Each *-step.ts references this;
 * for the registry see ./index.
 */

/** Verdict validity check (used in summary parsing; invalid / missing falls back to manual_review). */
export function isVerdict(v: unknown): v is AgentRecommendationVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

/**
 * Slimmed-down describe body for judge / summary: strips the low-signal "File Walkthrough" (the big per-file
 * classification / description table) and mermaid diagram blocks, keeping only high-value text like type / summary / description / assessment.
 * These two blocks add nothing substantive to judging "are there severe issues needing follow-up" or to summarizing
 * "the overall PR conclusion", yet consume a lot of tokens. Only used to feed judge / summary; does not affect the describe card display.
 */
export function compactDescribe(text: string): string {
  let out = text;
  // File Walkthrough: the <details><summary><h3>File Walkthrough... that pr-agent appends at the end, with nested details; strip from here to the end.
  const wt = /<details[^>]*>\s*<summary>\s*<h3>\s*File Walkthrough\s*<\/h3>\s*<\/summary>/i.exec(out);
  if (wt) out = out.slice(0, wt.index).trimEnd();
  // mermaid diagrams (the architecture diagram in Diagram Walkthrough): unused by judge / summary, so strip the code block itself.
  out = out.replace(/```mermaid[\s\S]*?```/gi, '').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Renders the review's code findings into an "id-addressable" list (so the judge can decide which one to issue a re-review follow-up on).
 * Only takes code-feedback / code-suggestion (anchorable code comments that a re-review can supersede); compress the body to one line and truncate to control length.
 */
function renderFindingsForJudge(findings: Finding[]): string {
  const code = findings.filter(
    (f) => f.sectionKey === 'code-feedback' || f.sectionKey === 'code-suggestion',
  );
  if (code.length === 0) return '(none)';
  return code
    .map((f) => {
      const a = f.anchor;
      const loc = a ? `${a.path}${a.startLine ? `:${String(a.startLine)}` : ''}` : '';
      const brief = f.body.replace(/\s+/g, ' ').trim().slice(0, 160);
      return `- id=${f.id}${loc ? ` (${loc})` : ''}: ${brief}`;
    })
    .join('\n');
}

/** The follow-up judge user instruction lives externally in resources/prompts/judge.md (placeholders maxAsks/language); describe/review bodies are appended here.
 *  The language is explicitly required to phrase questions in the session language (the lean system carries no assembleSystemContext language instruction, otherwise it defaults to English).
 *  findings: the structured findings parsed from review, rendered into an id-addressable list so the judge can issue a re-review follow-up on a given one (targetFindingId). */
export function judgePrompt(
  describeText: string,
  reviewText: string,
  findings: Finding[],
  maxAsks: number,
  language: string,
): string {
  // Same policy as renderLanguage: empty / unknown falls back to en-US.
  const lang = language.trim() || 'en-US';
  const head = fillTemplate(PROMPT_TEMPLATES.judge, { maxAsks: String(maxAsks), language: lang });
  return [
    head,
    '',
    '--- PR description ---',
    compactDescribe(describeText),
    '',
    '--- Review findings ---',
    reviewText,
    '',
    '--- Review findings (id-addressable, for targetFindingId) ---',
    renderFindingsForJudge(findings),
  ].join('\n');
}

/** The summary user instruction + three-section skeleton live externally in resources/prompts/summary.md (placeholders maxChars/three section titles);
 *  bodies like description / review findings / follow-up Q&A are appended here as needed (conditional assembly stays in TS). */
export function summaryPrompt(
  describeText: string,
  reviewText: string,
  askResults: string[],
  maxChars: number,
  sections: readonly [string, string, string],
): string {
  const [overview, findings, suggestions] = sections;
  const head = fillTemplate(PROMPT_TEMPLATES.summary, {
    maxChars: String(maxChars),
    overview,
    findings,
    suggestions,
  });
  return [
    head,
    '',
    '--- Description ---',
    compactDescribe(describeText),
    '',
    '--- Review findings ---',
    reviewText,
    ...(askResults.length ? ['', '--- Follow-up Q&A ---', askResults.join('\n\n')] : []),
  ].join('\n');
}

/** Intermediate products passed across steps. */
export interface ReviewBag {
  describe?: ToolText;
  /** review tool output (includes runId / findings, for the judge to name + link asks re-reviews). */
  review?: ToolText;
  /** follow-up asks decided by the judge (consumed by the asks step); when targetFindingId is present = a re-review follow-up on that review finding. */
  asks: Array<{ question: string; targetFindingId?: string }>;
  askResults: string[];
  summary?: string;
  recommendation?: AgentRecommendation;
}

/** Run context for the review steps: deps + input + shared recorder + cross-step accumulator (bag). */
export interface ReviewStepCtx {
  deps: ReviewOrchestratorDeps;
  input: ReviewOrchestratorInput;
  rec: StepRecorder;
  /** User stop: boundary check at each step; if already aborted, throw `用户暂停` (the thinking phase can be interrupted immediately too). */
  checkAbort: () => void;
  maxAsks: number;
  summaryMax: number;
  labels: AgentStepLabels;
  /** Full micro-flow system context (used by summary; judge uses the lean JUDGE_SYSTEM instead). */
  system: string;
  bag: ReviewBag;
}
