// 必须在用到 @monaco-editor/react 之前执行（见 DiffView 同款说明）。本文件经
// React.lazy 动态加载 → Monaco 随本 chunk 按需拉取，不进入口包。
import '../../../../../lib/monaco-setup';
import { Editor, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrCommentAnchor, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { editorFontSize } from '../../../../../lib/editor-font';
import { useMonacoEditorTheme } from '../../../../../hooks/useTheme';
import { useEditorAppearance } from '../../../../../stores/editor-appearance-store';
import { resolveEditorFontFamily } from '../../../../../theme';
import { languageFor } from '../../../../../utils/language';

interface InlineCodeContextProps {
  pr: StoredPullRequest;
  anchor: PrCommentAnchor;
  /** 锚定行前后展示的上下文行数；默认 5 */
  contextLines?: number;
  /**
   * 进入页面时是否自动挂 Monaco 编辑器。CommentsPanel 默认对最新前 N 条 inline
   * 评论 (AUTO_EXPAND_CAP) 传 true，超额条目传 false → 渲染"展开代码"按钮，
   * 用户点击才挂 editor (懒加载)，避免 PR 评论很多时一次性把页面拖慢
   */
  autoExpand?: boolean;
}

/**
 * 评论里 inline 引用的代码上下文：Monaco read-only 编辑器，展示锚定行前后若干行，
 * 锚定行用整行底色高亮 (跟 Bitbucket 内嵌评论的视觉惯例一致)。
 *
 * 取数走 `diff:getFileContent` —— 跟 DiffView 同一份本地 git blob，无远端往返；
 * mirror 还没拉齐 base/head sha 时 (rare，poll 已经先 sync 过) 走 syncMirror 兜底。
 *
 * 性能：每个 inline 评论都会挂一个 Monaco 实例 (读 + tokenize)。CommentsPanel 控
 * 默认只 auto-expand 前 N 条 (按时间线)，超额走 click-to-expand 懒加载。
 */
function InlineCodeContextImpl({
  pr,
  anchor,
  contextLines = 5,
  autoExpand = true,
}: InlineCodeContextProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(autoExpand);
  const [snippet, setSnippet] = useState<{
    text: string;
    startLine: number;
    anchorInSnippet: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 未展开时不拉文件 — 给用户主动控制懒加载的语义
    if (!expanded) return;
    let cancelled = false;
    setSnippet(null);
    setError(null);
    void (async () => {
      try {
        const c = await invoke('diff:getFileContent', {
          localId: pr.localId,
          // anchor.side 'old' 锚到 base 侧，'new' 锚到 head 侧
          side: anchor.side === 'old' ? 'base' : 'head',
          path: anchor.path,
        });
        if (cancelled) return;
        if (c.binary) {
          setError(t('inlineCodeContext.binaryNoContext'));
          return;
        }
        const allLines = c.content.split('\n');
        const startLine = Math.max(1, anchor.line - contextLines);
        const endLine = Math.min(allLines.length, anchor.line + contextLines);
        const text = allLines.slice(startLine - 1, endLine).join('\n');
        setSnippet({ text, startLine, anchorInSnippet: anchor.line - startLine + 1 });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 故意不依赖 t：useTranslation 的 t 会在 i18n languageChanged 时换新引用（poll 刷新也可能触发），
    // 把它放进依赖会让本 effect 无谓重跑 → setSnippet(null) → 内嵌 Monaco 卸载重建（刷新抖动）。
    // t 仅用于错误文案，重抓时机只该由 expanded / pr / anchor 决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, pr.localId, anchor.path, anchor.side, anchor.line, contextLines]);

  if (!expanded) {
    return (
      <button
        type="button"
        className="comment-code-context-toggle"
        onClick={() => setExpanded(true)}
        title={t('inlineCodeContext.expandTitle')}
      >
        {t('inlineCodeContext.expandLabel', { path: anchor.path, line: anchor.line })}
      </button>
    );
  }
  if (error) {
    return <div className="comment-code-context-error muted">{error}</div>;
  }
  if (!snippet) {
    return (
      <div className="comment-code-context-loading muted">{t('inlineCodeContext.loading')}</div>
    );
  }

  return <CodeSnippet snippet={snippet} language={languageFor(anchor.path)} />;
}

/** Monaco fs=12 时近似行高；上下各 6px padding */
const SNIPPET_LINE_HEIGHT = 19;

const READONLY_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  // keep-alive：评论 tab 切走时本编辑器被 display:none（尺寸归 0），切回需重排。
  // automaticLayout 让 Monaco 自带 ResizeObserver 在显隐时自动 layout，避免切回空白/错位。
  automaticLayout: true,
};

interface Snippet {
  text: string;
  startLine: number;
  anchorInSnippet: number;
}

/**
 * 只读代码片段编辑器。**独立 memo 组件**：props 只有稳定的 snippet（值不变就同一引用）+ language，
 * 与父级 CommentItem / CommentsPanel 的任何重渲染（poll / 焦点刷新触发的 pr 换引用等）彻底隔离。
 * 父级重渲染时本组件按 props 浅比较 bail → 不重建 <Editor> 元素 → @monaco-editor/react 的 value /
 * options effect 都不触发（避免只读编辑器被无条件 setValue 重置 → 重新 tokenize 的刷新抖动）。
 * onMount / options 也用稳定引用，杜绝即便重渲染时的 updateOptions 抖动。
 */
const CodeSnippet = memo(function CodeSnippet({
  snippet,
  language,
}: {
  snippet: Snippet;
  language: string;
}) {
  // Monaco 内置主题不走 CSS 自定义属性，须显式切换：按编辑器主题偏好（'auto' 跟随 GUI 深浅）解析。
  const monacoTheme = useMonacoEditorTheme();
  // 等宽字体随配置切换；并进 options（@monaco-editor/react 按引用比对，故 useMemo 稳定 + 仅字体变时重建）。
  const fontFamily = resolveEditorFontFamily(useEditorAppearance().fontFamily);
  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({ ...READONLY_OPTIONS, fontFamily }),
    [fontFamily],
  );
  const lineCount = snippet.text.split('\n').length;
  const height = lineCount * SNIPPET_LINE_HEIGHT + 12;

  const handleMount = useCallback(
    (ed: editor.IStandaloneCodeEditor, monaco: Monaco): void => {
      // 真实文件行号 = snippet 内部行号 + startLine - 1。Monaco lineNumbers 函数式
      // 完全可控，把内部 1..N 映射回去
      ed.updateOptions({
        readOnly: true,
        domReadOnly: true,
        lineNumbers: (lineNo) => String(lineNo + snippet.startLine - 1),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        renderLineHighlight: 'none',
        contextmenu: false,
        folding: false,
        glyphMargin: false,
        fontSize: editorFontSize(12),
        lineHeight: SNIPPET_LINE_HEIGHT,
        padding: { top: 6, bottom: 6 },
        // 行宽自适应，长行用 word wrap 而不是横向滚动条 (滚动条已禁)
        wordWrap: 'on',
      });
      // 锚定行整行底色：用 Monaco decorations。线条 className 走 CSS 决定颜色
      ed.createDecorationsCollection([
        {
          range: new monaco.Range(snippet.anchorInSnippet, 1, snippet.anchorInSnippet, 1),
          options: {
            isWholeLine: true,
            className: 'comment-code-context-anchor-line',
            marginClassName: 'comment-code-context-anchor-gutter',
          },
        },
      ]);
    },
    [snippet],
  );

  return (
    <div className="comment-code-context" style={{ height: `${String(height)}px` }}>
      <Editor
        height={`${String(height)}px`}
        language={language}
        value={snippet.text}
        theme={monacoTheme}
        onMount={handleMount}
        options={options}
      />
    </div>
  );
});

/**
 * 按**锚点值**（path / line / side）+ pr.localId + 展示选项比较的 memo：父级（CommentsPanel）在 poll
 * 重渲染时会传新的 anchor / pr **对象引用**（值未变），默认浅比较会误判变化 → 内嵌 Monaco 重渲染重排
 * （刷新抖动）。这里按值比较，定位信息没变就跳过整个组件，Monaco 不动。
 */
export const InlineCodeContext = memo(
  InlineCodeContextImpl,
  (prev, next) =>
    prev.pr.localId === next.pr.localId &&
    prev.anchor.path === next.anchor.path &&
    prev.anchor.line === next.anchor.line &&
    prev.anchor.side === next.anchor.side &&
    (prev.contextLines ?? 5) === (next.contextLines ?? 5) &&
    (prev.autoExpand ?? true) === (next.autoExpand ?? true),
);
