import type { Components } from 'react-markdown';
import { MermaidDiagram } from './MermaidDiagram';

const MERMAID_LANG = /\blanguage-mermaid\b/;

/**
 * react-markdown components override: render ```mermaid code blocks as diagrams (see MermaidDiagram),
 * keep other code blocks at their default. Merged into the `components` of each markdown surface (comments / PR description / chat output).
 *
 * - `code`: matches language-mermaid → render diagram; otherwise verbatim <code>.
 * - `pre`: mermaid blocks drop the outer <pre> (the diagram brings its own container, avoiding the code block's monospace / border framing).
 */
export const mermaidComponents: Components = {
  code({ node: _node, className, children, ...rest }) {
    if (className && MERMAID_LANG.test(className)) {
      // children may be an array (a common react-markdown shape): String(array) joins with commas and breaks
      // the mermaid DSL, so concatenate its string items (ignoring non-strings) before passing them in.
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
      // mermaid: render the diagram produced by the code override directly, without wrapping in <pre>
      return <>{children}</>;
    }
    return <pre {...rest}>{children}</pre>;
  },
};

/**
 * Dedicated components for the describe "file changes" walkthrough: on top of the mermaid override, also strip the <details> open
 * attribute. pr-agent outputs each file category (feature enhancement / config change …) as <details open> expanded by default; with many files the body
 * gets very long; removing open makes each category collapse by default, click the <summary> title to expand on demand (native <details> interaction, not persisted).
 */
export const walkthroughMdComponents: Components = {
  ...mermaidComponents,
  details: ({ node: _node, open: _open, ...rest }) => <details {...rest} />,
};
