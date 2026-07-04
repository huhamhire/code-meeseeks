import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { DatabaseIcon, QuestionIcon, mermaidComponents } from '../../../common';
import { formatTokens } from '../utils/format';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { parseAnsi, segmentStyle } from '../../../../utils/ansi';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Bullet({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="chat-empty-bullet" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/** Unified markdown rendering for the chat area (same remark/rehype config as finding cards). */
export function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={REMOTE_REHYPE_PLUGINS}
      components={mermaidComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

/** Inline markdown: for single-line text such as titles, rendering inline code / emphasis, dropping the block-level <p> wrapper to keep inline layout. */
export function MdInline({ children }: { children: string }) {
  // When a title starts with a list marker like "2. " or "- ", markdown parses it into an <ol>/<ul> block stuffed into <h4>, breaking the inline layout
  // and overflowing. Escape leading list markers to render the number / symbol literally (keeping the text), no longer generating a list block.
  const inlineSafe = children
    .replace(/^(\s*)(\d+)\.(\s)/, '$1$2\\.$3')
    .replace(/^(\s*)([-*+])(\s)/, '$1\\$2$3');
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={REMOTE_REHYPE_PLUGINS}
      components={{ p: ({ children }) => <>{children}</> }}
    >
      {inlineSafe}
    </ReactMarkdown>
  );
}

/**
 * `<summary>` inline markdown rendering: text inside raw-HTML collapse titles (e.g. the <details><summary> of each option under "suggestions")
 * is not re-parsed by markdown, so backticks / emphasis leak through verbatim. Here we route its plain text through {@link MdInline}, so that
 * `code` / **emphasis** in the title take effect. children is usually a plain-text string; falls back to rendering verbatim when it contains non-text nodes.
 */
const SummaryInlineMd: Components['summary'] = ({ children }) => {
  const text =
    typeof children === 'string'
      ? children
      : Array.isArray(children) && children.every((c) => typeof c === 'string')
        ? children.join('')
        : null;
  return text != null ? (
    <summary>
      <MdInline>{text}</MdInline>
    </summary>
  ) : (
    <summary>{children}</summary>
  );
};

/** Layer "<summary> inline markdown" rendering on top of the given markdown components (collapse titles support md pre-formatting). */
export function withInlineSummary(base: Components): Components {
  return { ...base, summary: SummaryInlineMd };
}

/**
 * Code-path line-break optimization: insert <wbr> soft break points after the separator `/` and the connectors `.` `_` `-`, combined with CSS
 * `word-break: normal`, so long paths preferentially break at these characters (rather than mid-word), ensuring readability.
 */
export function BreakablePath({ path }: { path: string }) {
  const parts = path.split(/(?<=[/._-])/);
  const nodes: ReactNode[] = [];
  parts.forEach((p, i) => {
    nodes.push(p);
    if (i < parts.length - 1) nodes.push(<wbr key={`wbr-${i}`} />);
  });
  return <>{nodes}</>;
}

/** Render ANSI-escaped stdout text into a colored <pre>. Shows a placeholder when the text is empty */
export function AnsiPre({
  className,
  text,
  preRef,
  placeholder,
}: {
  className?: string;
  text: string;
  preRef?: Ref<HTMLPreElement>;
  placeholder?: string;
}) {
  if (!text) {
    return (
      <pre className={className} ref={preRef}>
        {placeholder ?? ''}
      </pre>
    );
  }
  const segments = parseAnsi(text);
  return (
    <pre className={className} ref={preRef}>
      {segments.map((seg, i) => (
        <span key={i} style={segmentStyle(seg)}>
          {seg.text}
        </span>
      ))}
    </pre>
  );
}

/**
 * Inline token-usage display: ↑input(green) [⛁cache hit] / ↓output(red). Input and output **each get their own hover tooltip**;
 * the cache hit (cache_read) is part of the input, shown split out with a bar icon (spacing before cache, the whole segment not rendered and leaving no gap when there's no hit),
 * with its own tooltip on hover. Shared by the run card (RunMeta) and the thinking step (AgentStep); the separator is passed by context (` / ` inside a chip, a space on step rows).
 */
export function TokenStat({
  prompt,
  completion,
  cacheRead,
  separator = ' / ',
}: {
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  separator?: string;
}) {
  const { t } = useTranslation();
  if (prompt === undefined && completion === undefined) return null;
  return (
    <>
      {prompt !== undefined && (
        <span className="chat-token-grp" title={t('chatPane.tokensInTitle', { n: prompt })}>
          <span className="chat-token-in">↑</span>
          {formatTokens(prompt)}
          {cacheRead !== undefined && cacheRead > 0 && (
            <span
              className="chat-token-cache"
              title={t('chatPane.cacheInline', { n: formatTokens(cacheRead) })}
            >
              <DatabaseIcon />
              {formatTokens(cacheRead)}
            </span>
          )}
        </span>
      )}
      {prompt !== undefined && completion !== undefined ? separator : ''}
      {completion !== undefined && (
        <span className="chat-token-grp" title={t('chatPane.tokensOutTitle', { n: completion })}>
          <span className="chat-token-out">↓</span>
          {formatTokens(completion)}
        </span>
      )}
    </>
  );
}

/** /ask question row: a question-mark icon + markdown-rendered question content (the Agent's self-composed follow-up asks often contain inline code / lists). */
export function AskQuestion({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="chat-user-msg" aria-label={t('chatPane.userQuestionAria')}>
      <QuestionIcon />
      <div className="markdown chat-user-msg-body">
        <Md>{text}</Md>
      </div>
    </div>
  );
}
