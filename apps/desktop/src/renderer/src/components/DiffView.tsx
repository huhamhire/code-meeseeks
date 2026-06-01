 import { useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  DiffBlameLine,
  DiffChangedFile,
  DiffFileContent,
  PrComment,
  StoredPullRequest,
  SyncProgressEvent,
} from '@pr-pilot/shared';
import { invoke } from '../api';
import { Avatar } from './Avatar';
import { FileTree } from './FileTree';

interface DiffViewProps {
  pr: StoredPullRequest;
  renderSideBySide: boolean;
  showBlame: boolean;
}

interface LoadedContent {
  base: DiffFileContent;
  head: DiffFileContent;
}

const DIFF_FILE_LIST_MIN = 180;
const DIFF_FILE_LIST_MAX = 560;
const DIFF_FILE_LIST_DEFAULT = 280;

export function DiffView({ pr, renderSideBySide, showBlame }: DiffViewProps) {
  const [files, setFiles] = useState<DiffChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [content, setContent] = useState<LoadedContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [blame, setBlame] = useState<DiffBlameLine[] | null>(null);
  const [fileListWidth, setFileListWidth] = useState<number>(() => {
    const raw = localStorage.getItem('pr-pilot.diffFileListWidth');
    const n = raw ? Number(raw) : DIFF_FILE_LIST_DEFAULT;
    return Math.min(
      DIFF_FILE_LIST_MAX,
      Math.max(DIFF_FILE_LIST_MIN, Number.isFinite(n) ? n : DIFF_FILE_LIST_DEFAULT),
    );
  });
  useEffect(() => {
    localStorage.setItem('pr-pilot.diffFileListWidth', String(fileListWidth));
  }, [fileListWidth]);

  const startFileListResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = fileListWidth;
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const next = Math.min(
        DIFF_FILE_LIST_MAX,
        Math.max(DIFF_FILE_LIST_MIN, startWidth + dx),
      );
      setFileListWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  // 用 state 而非 ref：onMount 异步触发，必须靠 state 变更触发后续 useEffect
  // 重新运行 decorations 应用逻辑。
  const [diffEditor, setDiffEditor] = useState<MonacoEditor.IStandaloneDiffEditor | null>(
    null,
  );

  // 订阅 sync:progress 并按当前 PR 所属 repo 过滤
  const repoKeySuffix = `/${pr.repo.projectKey}/${pr.repo.repoSlug}`;
  useEffect(() => {
    const unsubscribe = window.api.subscribe('sync:progress', (event) => {
      if (event.repo.endsWith(repoKeySuffix)) setProgress(event);
    });
    return unsubscribe;
  }, [repoKeySuffix]);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    setSelectedKey(null);
    setContent(null);
    setProgress(null);
    setComments([]);
    invoke('diff:listChangedFiles', { localId: pr.localId })
      .then((f) => {
        if (cancelled) return;
        setFiles(f);
        if (f.length > 0) setSelectedKey(fileKey(f[0]!));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    // 评论独立拉，失败不阻塞 diff 展示
    invoke('diff:listComments', { localId: pr.localId })
      .then((cs) => {
        if (!cancelled) setComments(cs);
      })
      .catch((e: unknown) => {
        console.warn('failed to load comments', e);
      });
    return () => {
      cancelled = true;
    };
  }, [pr.localId]);

  const selected = files?.find((f) => fileKey(f) === selectedKey) ?? null;

  // 给文件树用：path → 锚到该文件的评论数（含双 path 别名 + renamed 的 oldPath）
  const commentCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    if (!files) return m;
    for (const f of files) {
      const n = comments.filter(
        (c) =>
          c.anchor &&
          (c.anchor.path === f.path || (f.oldPath && c.anchor.path === f.oldPath)),
      ).length;
      if (n > 0) m.set(f.path, n);
    }
    return m;
  }, [files, comments]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContent(null);
    const basePath = selected.oldPath ?? selected.path;
    const headPath = selected.path;
    Promise.all([
      invoke('diff:getFileContent', { localId: pr.localId, side: 'base', path: basePath }),
      invoke('diff:getFileContent', { localId: pr.localId, side: 'head', path: headPath }),
    ])
      .then(([base, head]) => {
        if (!cancelled) setContent({ base, head });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, pr.localId]);

  // 拉 blame：仅在开关开 + 文件有 head 内容时跑。deleted 文件 / 二进制不跑。
  useEffect(() => {
    if (!showBlame || !selected || !content || content.head.binary) {
      setBlame(null);
      return;
    }
    if (selected.status === 'deleted') {
      setBlame(null);
      return;
    }
    let cancelled = false;
    invoke('diff:getBlame', { localId: pr.localId, path: selected.path })
      .then((b) => {
        if (!cancelled) setBlame(b);
      })
      .catch(() => {
        if (!cancelled) setBlame(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showBlame, selected, content, pr.localId]);

  // 在 modified editor 行首注入 blame 文本，伪装成左侧固定列。同 commit
  // 的连续行只在第一行显示文本，其余留空白占位（VS Code GitLens 同样做法）。
  useEffect(() => {
    if (!diffEditor) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    if (!blame || blame.length === 0) {
      modifiedEditor.updateOptions({ lineDecorationsWidth: 10 });
      return;
    }
    modifiedEditor.updateOptions({ lineDecorationsWidth: 10 });
    let prevSha = '';
    const decos: MonacoEditor.IModelDeltaDecoration[] = blame.map((b) => {
      const sameAsPrev = b.commit === prevSha;
      prevSha = b.commit;
      //   等宽空格保持占位列稳定
      const text = sameAsPrev ? ' ' : formatBlame(b);
      const hover = `**${b.author}** · ${formatBlameDate(b.authorDate, false)}  \n\`${b.commit.slice(0, 12)}\` ${b.summary}`;
      return {
        range: {
          startLineNumber: b.line,
          startColumn: 1,
          endLineNumber: b.line,
          endColumn: 1,
        },
        options: {
          before: { content: text, inlineClassName: 'monaco-blame-inline' },
          hoverMessage: { value: hover },
        },
      };
    });
    const coll = modifiedEditor.createDecorationsCollection(decos);
    return () => {
      try {
        coll.clear();
      } catch {
        /* editor disposed */
      }
    };
  }, [diffEditor, blame]);

  // 行内标记：评论锚定行 glyph margin 蓝点 + 行下方插 view zone 渲染评论内容
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const fileComments = comments.filter(
      (c) =>
        c.anchor &&
        (c.anchor.path === selected.path ||
          (selected.oldPath && c.anchor.path === selected.oldPath)),
    );

    const oldByLine = new Map<number, PrComment[]>();
    const newByLine = new Map<number, PrComment[]>();
    for (const c of fileComments) {
      const target = c.anchor!.side === 'old' ? oldByLine : newByLine;
      const arr = target.get(c.anchor!.line) ?? [];
      arr.push(c);
      target.set(c.anchor!.line, arr);
    }

    const buildDecorations = (
      byLine: Map<number, PrComment[]>,
    ): MonacoEditor.IModelDeltaDecoration[] =>
      Array.from(byLine.entries()).map(([line, cs]) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          isWholeLine: true,
          glyphMarginClassName: 'monaco-comment-glyph',
          glyphMarginHoverMessage: { value: renderHoverMd(cs) },
          linesDecorationsClassName: 'monaco-comment-line-deco',
        },
      }));

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalDecorations = originalEditor.createDecorationsCollection(
      buildDecorations(oldByLine),
    );
    const modifiedDecorations = modifiedEditor.createDecorationsCollection(
      buildDecorations(newByLine),
    );

    // view zones: 在行下方插入评论 DOM 块（React 渲染）
    const zoneRefs: Array<{
      editor: MonacoEditor.ICodeEditor;
      zoneId: string;
      dom: HTMLElement;
      root: Root;
    }> = [];

    const addZonesFor = (
      editorInst: MonacoEditor.ICodeEditor,
      byLine: Map<number, PrComment[]>,
    ): void => {
      editorInst.changeViewZones((accessor) => {
        for (const [line, cs] of byLine) {
          const dom = document.createElement('div');
          dom.className = 'monaco-comment-zone';
          const root = createRoot(dom);
          root.render(<CommentZone comments={cs} connectionId={pr.connectionId} />);
          const zoneId = accessor.addZone({
            afterLineNumber: line,
            heightInLines: estimateZoneHeight(cs),
            domNode: dom,
          });
          zoneRefs.push({ editor: editorInst, zoneId, dom, root });
        }
      });
    };

    addZonesFor(originalEditor, oldByLine);
    addZonesFor(modifiedEditor, newByLine);

    return () => {
      try {
        originalDecorations.clear();
        modifiedDecorations.clear();
      } catch {
        // editor 已 dispose
      }
      try {
        originalEditor.changeViewZones((accessor) => {
          for (const z of zoneRefs) {
            if (z.editor === originalEditor) accessor.removeZone(z.zoneId);
          }
        });
        modifiedEditor.changeViewZones((accessor) => {
          for (const z of zoneRefs) {
            if (z.editor === modifiedEditor) accessor.removeZone(z.zoneId);
          }
        });
      } catch {
        /* editor disposed */
      }
      // React 18+: unmount 不能在 render 阶段同步调，放微任务里
      queueMicrotask(() => {
        for (const z of zoneRefs) {
          try {
            z.root.unmount();
          } catch {
            /* ignore */
          }
        }
      });
    };
  }, [diffEditor, comments, content, selected, pr.connectionId]);

  if (error) {
    return <div className="diff-empty diff-error">{error}</div>;
  }
  if (!files) {
    return (
      <div className="diff-empty">
        <SyncProgress progress={progress} />
      </div>
    );
  }
  if (files.length === 0) {
    return <div className="diff-empty">该 PR 无文件变更</div>;
  }

  return (
    <div className="diff-view">
      <aside className="diff-file-list" style={{ width: `${String(fileListWidth)}px` }}>
        <div className="diff-file-list-header">
          <span>{files.length} 个文件</span>
        </div>
        <FileTree
          files={files}
          selectedKey={selectedKey}
          commentCountByPath={commentCountByPath}
          onSelect={(f) => setSelectedKey(fileKey(f))}
        />
        <div
          className="diff-file-list-resize-handle"
          onMouseDown={startFileListResize}
          title="拖动调整文件树宽度"
          aria-label="resize diff file list"
        />
      </aside>
      <div className="diff-content">
        {selected && (
          <div className="diff-pane-wrapper">
            <DiffPane
              file={selected}
              content={content}
              loading={contentLoading}
              renderSideBySide={renderSideBySide}
              showBlame={showBlame}
              onMount={setDiffEditor}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 估算 view zone 高度（行数）。每段评论 = header(avatar+name+date, 1.3 行) + body
 * 字数 / 80 行向上取整；reply 同样 header + body，外加 reply 自己的 padding/border
 * 各 0.2 行。同行多评论叠加，最后顶天 32 行避免独吞屏幕。
 */
function estimateZoneHeight(comments: PrComment[]): number {
  let h = 1; // 上下 padding
  for (const c of comments) {
    h += 1.3 + Math.max(1, Math.ceil(c.body.length / 80));
    for (const r of c.replies) {
      // reply 自己有 margin + border，多 0.3 行
      h += 1.3 + Math.max(1, Math.ceil(r.body.length / 80)) + 0.3;
    }
    h += 0.3; // item 间分隔
  }
  return Math.min(Math.ceil(h), 32);
}

function CommentZone({
  comments,
  connectionId,
}: {
  comments: PrComment[];
  connectionId: string;
}) {
  return (
    <div className="comment-zone-inner">
      {comments.map((c, i) => (
        <div
          key={c.remoteId}
          className={`comment-zone-item${i > 0 ? ' comment-zone-item-divider' : ''}`}
        >
          <CommentAuthorRow
            displayName={c.author.displayName}
            slug={c.author.slug ?? c.author.name}
            connectionId={connectionId}
            at={c.createdAt}
          />
          <div className="comment-zone-body markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
          </div>
          {c.replies.map((r) => (
            <div key={r.remoteId} className="comment-zone-reply">
              <CommentAuthorRow
                displayName={r.author.displayName}
                slug={r.author.slug ?? r.author.name}
                connectionId={connectionId}
                at={r.createdAt}
              />
              <div className="comment-zone-body markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.body}</ReactMarkdown>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CommentAuthorRow({
  displayName,
  slug,
  connectionId,
  at,
}: {
  displayName: string;
  slug: string;
  connectionId: string;
  at: string;
}) {
  return (
    <div className="comment-zone-head">
      <Avatar
        connectionId={connectionId}
        slug={slug}
        displayName={displayName}
        size={18}
      />
      <strong>{displayName}</strong>
      <span className="muted">{new Date(at).toLocaleString()}</span>
    </div>
  );
}

function SyncProgress({ progress }: { progress: SyncProgressEvent | null }) {
  if (!progress) {
    return (
      <span className="muted">
        <Spinner /> 同步本地镜像…
      </span>
    );
  }
  if (progress.phase === 'error') {
    return <span className="diff-error">同步失败：{progress.message ?? '未知错误'}</span>;
  }
  // sync 完成后 IPC handler 还在跑 git diff 算变更文件列表（partial clone 下
  // 可能触发 tree 元数据拉取），显示对应阶段提示
  if (progress.phase === 'done') {
    return (
      <span className="muted">
        <Spinner /> 同步完成，正在拉取变更文件列表…
      </span>
    );
  }
  const label =
    progress.phase === 'start' ? progress.message ?? '准备同步' : progress.stage ?? '同步';
  const pct =
    progress.percent !== undefined && Number.isFinite(progress.percent) ? progress.percent : null;
  return (
    <div className="sync-progress">
      <div className="sync-progress-label">
        <span>{progress.repo}</span>
        <span>
          {label}
          {pct !== null ? ` · ${pct}%` : ''}
        </span>
      </div>
      {pct !== null && (
        <div className="sync-progress-bar">
          <div className="sync-progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function fileKey(f: DiffChangedFile): string {
  return `${f.oldPath ?? ''}|${f.path}`;
}

/** "Kyle 3天前 · a1b2c3d" 风格，截断长名 */
function formatBlame(b: DiffBlameLine): string {
  const who = b.author.length > 12 ? b.author.slice(0, 11) + '…' : b.author;
  const when = formatBlameDate(b.authorDate, true);
  const sha = b.commit.slice(0, 7);
  return `${who} ${when} · ${sha}`;
}

function formatBlameDate(iso: string, relative: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!relative) return d.toLocaleString();
  const diffSec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo`;
  return `${Math.round(diffMo / 12)}y`;
}

function DiffPane({
  file,
  content,
  loading,
  renderSideBySide,
  showBlame,
  onMount,
}: {
  file: DiffChangedFile;
  content: LoadedContent | null;
  loading: boolean;
  renderSideBySide: boolean;
  showBlame: boolean;
  onMount: (editor: MonacoEditor.IStandaloneDiffEditor) => void;
}) {
  if (loading || !content) {
    return (
      <div className="diff-empty">
        <span className="muted">
          <Spinner /> 拉取 <code>{file.path}</code> 内容…
          <br />
          <small>
            partial clone 下首次访问该文件需要从远端按需拉取 blob，可能略慢
          </small>
        </span>
      </div>
    );
  }
  if (content.base.binary || content.head.binary) {
    return <div className="diff-binary">⚠️ 二进制文件，不渲染 diff</div>;
  }
  return (
    <DiffEditor
      height="100%"
      language={languageFor(file.path)}
      original={content.base.content}
      modified={content.head.content}
      onMount={onMount}
      className={showBlame ? 'diff-editor-with-blame' : undefined}
      options={{
        readOnly: true,
        renderSideBySide,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        // 显式开 glyph margin，给行内评论标记留位置
        glyphMargin: true,
        // GitHub 风格折叠：未变更段缩成可展开占位行
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 10,
          minimumLineCount: 5,
          revealLineCount: 20,
        },
      }}
      theme="vs-dark"
    />
  );
}

/** 把多条同行评论合成 markdown hover 文本（含回复嵌套） */
function renderHoverMd(comments: PrComment[]): string {
  return comments
    .map((c) => {
      const head = `**${c.author.displayName}** · ${new Date(c.createdAt).toLocaleString()}`;
      const body = c.body.length > 600 ? c.body.slice(0, 600) + '…' : c.body;
      const replies = c.replies
        .map(
          (r) =>
            `> **${r.author.displayName}**: ${r.body.length > 200 ? r.body.slice(0, 200) + '…' : r.body}`,
        )
        .join('\n');
      return `${head}\n\n${body}${replies ? '\n\n' + replies : ''}`;
    })
    .join('\n\n---\n\n');
}

function languageFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    xml: 'xml',
    php: 'php',
    rb: 'ruby',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    dockerfile: 'dockerfile',
  };
  if (!ext || ext === filePath.toLowerCase()) {
    const base = filePath.split('/').pop()?.toLowerCase() ?? '';
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
  }
  return map[ext] ?? 'plaintext';
}
