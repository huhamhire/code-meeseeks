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

/** chat 区统一的 markdown 渲染（与 finding 卡片同套 remark/rehype 配置）。 */
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

/** 行内 markdown：用于标题等单行文本，渲染内联代码 / 强调，去掉块级 <p> 包裹保持行内排版。 */
export function MdInline({ children }: { children: string }) {
  // 标题以「2. 」「- 」这类列表标记开头时，markdown 会把它解析成 <ol>/<ul> 块塞进 <h4>，撑破内联布局
  // 并溢出。转义行首列表标记，按字面渲染序号 / 符号（保留文字），不再生成列表块。
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
 * `<summary>` 内联 markdown 渲染：raw HTML 的折叠标题（如「思路建议」各方案的 <details><summary>）内的
 * 文本不会被 markdown 二次解析，反引号 / 强调等会原样漏出。这里把其纯文本走 {@link MdInline}，让标题里的
 * `代码` / **强调** 生效。children 多为纯文本串；含非文本节点时原样渲染兜底。
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

/** 在给定 markdown components 之上叠加「<summary> 内联 markdown」渲染（折叠标题支持 md 预格式化）。 */
export function withInlineSummary(base: Components): Components {
  return { ...base, summary: SummaryInlineMd };
}

/**
 * 代码路径折行优化：在分隔符 `/` 与连接符 `.` `_` `-` 之后插入 <wbr> 软断点，配合 CSS
 * `word-break: normal`，让长路径优先按这些字符折断（而非从单词中间断开），保证可读性。
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

/** 把含 ANSI 转义的 stdout 文本渲染成带颜色的 <pre>。空文本时显示占位 */
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
 * Token 用量内联展示：↑输入(绿) [⛁缓存命中] / ↓输出(红)。输入、输出**各自独立 hover 提示**；
 * 缓存命中(cache_read)为输入的一部分，柱体图标拆分展示（间距在 cache 前，无命中时整段不渲染、不留空），
 * 悬浮另给说明。run 卡片(RunMeta) 与思考步骤(AgentStep) 共用；分隔符按上下文传入（chip 内 ` / `、步骤行空格）。
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

/** /ask 提问行：问号图标 + markdown 渲染的提问内容（Agent 自拟的追问常含内联代码 / 列表）。 */
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
