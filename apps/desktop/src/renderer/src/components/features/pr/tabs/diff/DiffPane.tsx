import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@monaco-editor/react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import { editorFontSize } from '../../../../../lib/editor-font';
import { languageFor } from '../../../../../utils/language';
import { PaneLoading } from '../../../../common';
import { Spinner } from './DiffStatus';
import type { LoadedContent } from './diff-types';

export function DiffPane({
  file,
  content,
  loading,
  renderSideBySide,
  showBlame,
  showWhitespace,
  onMount,
}: {
  file: DiffChangedFile;
  content: LoadedContent | null;
  loading: boolean;
  renderSideBySide: boolean;
  showBlame: boolean;
  showWhitespace: boolean;
  onMount: (editor: MonacoEditor.IStandaloneDiffEditor) => void;
}) {
  const { t } = useTranslation();
  // Monaco 挂载后 diff 还要异步计算 + hideUnchangedRegions 折叠才稳定（见上文 reveal 逻辑），
  // 期间编辑器是「空 → 跳一下」的重排。在它之上盖一层 overlay loading，首次 onDidUpdateDiff
  // （或挂载即已算完）后卸载，遮住这段抖动一次性 reveal。DiffPane 按 file path keyed →
  // 切文件自然 remount，diffReady 随之复位。
  const [diffReady, setDiffReady] = useState(false);
  // options 必须 useMemo 稳定引用：@monaco-editor/react 对 options **按引用**比对，引用一变就
  // editor.updateOptions()。父级 DiffView 随 poll（pr 换新对象引用）重渲染 → DiffPane 重渲染，
  // 若每次新建 options 字面量，每次 poll 都触发 updateOptions → hideUnchangedRegions 折叠布局重算 →
  // 编辑器渲染抖动。只在真正影响项（并排/空白/字号）变化时重建。
  const fontSize = editorFontSize(14);
  const editorOptions = useMemo<MonacoEditor.IDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      renderSideBySide,
      // keep-alive：tab 切走时本编辑器被 display:none（尺寸归 0），切回需重排。automaticLayout
      // 让 Monaco 自带 ResizeObserver 在显隐/尺寸变化时自动 layout，避免切回空白/错位。
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize,
      scrollBeyondLastLine: false,
      // 关掉 diff 专属的合并总览列（renderOverviewRuler=true 会在两侧滚动条之外再加一条宽列，
      // 跟 VS Code 编辑模式「滚动条内打标」不一致）。改走编辑模式效果：内层 modified 编辑器自带的
      // overview ruler（默认渲染、独立于 minimap）+ 行内评论装饰的 overviewRuler 投影（见 useCommentZones）。
      renderOverviewRuler: false,
      // 显式 3 道：让 overview ruler 按 1/3 分道（diff 占左道、评论占右道，各 1/3 宽），
      // 避免被按 2 道算成各占一半，色条更细。
      overviewRulerLanes: 3,
      // 显式开 glyph margin，给行内评论标记留位置
      glyphMargin: true,
      // 空白字符可视化：toolbar 按钮控制；'all' 时空格显示 · / Tab 显示 →
      renderWhitespace: showWhitespace ? 'all' : 'none',
      // GitHub 风格折叠：未变更段缩成可展开占位行
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 10,
        minimumLineCount: 5,
        revealLineCount: 20,
      },
      // 关掉依赖 ts.worker 的高级特性（diff review 不需要），同时消掉
      // `Missing requestHandler` 噪音。hover 保留给 blame / 评论装饰用。
      inlayHints: { enabled: 'off' },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      parameterHints: { enabled: false },
      codeLens: false,
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
    }),
    [renderSideBySide, showWhitespace, fontSize],
  );
  const handleMount = useCallback(
    (editor: MonacoEditor.IStandaloneDiffEditor) => {
      onMount(editor);
      // diff 算完触发 onDidUpdateDiff，但 hideUnchangedRegions 折叠的布局还要再 paint
      // 一两帧才稳定 → 不在事件里立即揭开（否则露出折叠那一跳），略等 80ms 让折叠 paint
      // 完成、overlay 一直盖着，再一次性 reveal。
      const reveal = (): void => {
        window.setTimeout(() => setDiffReady(true), 80);
      };
      if (editor.getLineChanges() != null) {
        reveal();
        return;
      }
      const d = editor.onDidUpdateDiff(() => {
        d.dispose();
        reveal();
      });
    },
    [onMount],
  );
  if (loading || !content) {
    return (
      <div className="diff-empty">
        <span className="muted">
          <Spinner /> {t('diffView.loadingContentPrefix')} <code>{file.path}</code>{' '}
          {t('diffView.loadingContentSuffix')}
          <br />
          <small>{t('diffView.loadingContentHint')}</small>
        </span>
      </div>
    );
  }
  if (content.base.binary || content.head.binary) {
    return <div className="diff-binary">{t('diffView.binaryNotRendered')}</div>;
  }
  return (
    <div className="diff-pane-editor">
      {!diffReady && <PaneLoading overlay delayMs={0} />}
      <DiffEditor
        height="100%"
        language={languageFor(file.path)}
        original={content.base.content}
        modified={content.head.content}
        onMount={handleMount}
        className={
          [showBlame ? 'diff-editor-with-blame' : '', showWhitespace ? 'diff-editor-show-eol' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        options={editorOptions}
        theme="vs-dark"
      />
    </div>
  );
}
