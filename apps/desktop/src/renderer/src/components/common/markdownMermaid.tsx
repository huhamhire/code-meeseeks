import type { Components } from 'react-markdown';
import { MermaidDiagram } from './MermaidDiagram';

const MERMAID_LANG = /\blanguage-mermaid\b/;

/**
 * react-markdown components 覆盖：把 ```mermaid 代码块渲染成图（见 MermaidDiagram），
 * 其余代码块保持默认。合并进各 markdown 面的 `components`（评论 / PR 描述 / chat 输出）。
 *
 * - `code`：命中 language-mermaid → 渲染图；否则原样 <code>。
 * - `pre`：mermaid 块去掉外层 <pre>（图自带容器，避免被代码块的 monospace / 边框框住）。
 */
export const mermaidComponents: Components = {
  code({ node: _node, className, children, ...rest }) {
    if (className && MERMAID_LANG.test(className)) {
      // children 可能是数组（react-markdown 常见形态）：String(array) 会用逗号拼接破坏
      // mermaid DSL，需先拼接其中字符串项（非字符串忽略）再传入。
      const text = Array.isArray(children)
        ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
        : typeof children === 'string'
          ? children
          : String(children ?? '');
      return <MermaidDiagram source={text.replace(/\n+$/, '')} />;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre({ node: _node, children, ...rest }) {
    const first = Array.isArray(children) ? children[0] : children;
    const cls =
      first && typeof first === 'object' && 'props' in first
        ? (first as { props?: { className?: unknown } }).props?.className
        : undefined;
    if (typeof cls === 'string' && MERMAID_LANG.test(cls)) {
      // mermaid：直接渲染 code 覆盖产出的图，不套 <pre>
      return <>{children}</>;
    }
    return <pre {...rest}>{children}</pre>;
  },
};

/**
 * describe「文件变更」walkthrough 专用 components：在 mermaid 覆盖之上再去掉 <details> 的 open
 * 属性。pr-agent 把各文件分类（功能增强 / 配置变更 …）输出为 <details open> 默认展开，文件多时正文
 * 很长；去掉 open 让每个分类默认折叠收起，点 <summary> 标题按需展开（原生 <details> 交互、不持久化）。
 */
export const walkthroughMdComponents: Components = {
  ...mermaidComponents,
  details: ({ node: _node, open: _open, ...rest }) => <details {...rest} />,
};
