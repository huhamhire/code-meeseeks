// 必须在用到 @monaco-editor/react 之前执行（loader.config 指向本地 monaco）。
// 本文件经 React.lazy 动态加载，故 Monaco 随本 chunk 按需拉取，不进入口包。
import '../monaco-setup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffEditor } from '@monaco-editor/react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type {
  DiffBlameLine,
  DiffChangedFile,
  DiffFileContent,
  DiffHunkRange,
  PrComment,
  ReviewDraft,
  StoredPullRequest,
  SyncProgressEvent,
} from '@meebox/shared';
import { policyForPlatform } from '@meebox/shared';
import { invoke, subscribe } from '../api';
import { editorFontSize } from '../editor-font';
import { formatBackendError, type FormattedError } from '../errors';
import { REMOTE_REHYPE_PLUGINS } from '../markdown';
import { useDraftsForPr } from '../stores/drafts-store';
import { Avatar } from './Avatar';
import { DraftZone } from './DraftZone';
import { ErrorBoundary } from './ErrorBoundary';
import { makeBitbucketImageFor, transformBitbucketUrl } from './BitbucketImage';
import { CommentEditEditor } from './CommentEditEditor';
import { CommentReplyEditor } from './CommentReplyEditor';
import { ConfirmModal } from './ConfirmModal';
import { DiffSearchPanel } from './DiffSearchPanel';
import { FileTree } from './FileTree';
import { FileTreeIcon, SearchIcon } from './icons';

interface DiffViewProps {
  pr: StoredPullRequest;
  renderSideBySide: boolean;
  showBlame: boolean;
  showWhitespace: boolean;
  /**
   * M4 跳转目标：来自 ChatPane finding card → App pendingDiffNav。
   * 非 null 时 DiffView 切到该文件 + 滚到 anchor 行 + 短暂高亮 + (带 runId/findingId
   * 时) 打开 inline 草稿编辑 zone (草稿已由 ChatPane 端懒创建)。
   * runId/findingId 缺省 (PublishReviewModal anchor 点击) → 仅 navigate 不 enter edit。
   * 消费完调 onNavConsumed 清空 token
   */
  pendingNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onNavConsumed?: () => void;
}

interface LoadedContent {
  base: DiffFileContent;
  head: DiffFileContent;
}

const DIFF_FILE_LIST_MIN = 180;
const DIFF_FILE_LIST_MAX = 560;
const DIFF_FILE_LIST_DEFAULT = 280;

/** Bitbucket 风格 blame 列宽：头像(20) + name(80) + sha(75) + date(45) + padding */
const BLAME_COLUMN_WIDTH = 240;

interface BlameLayout {
  /** Monaco modified editor 可视高度 (px) */
  viewportHeight: number;
  /** Monaco 当前行高 (px) */
  lineHeight: number;
  /** Monaco 当前垂直滚动 (px) */
  scrollTop: number;
}

interface BlameBlock {
  commit: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  summary: string;
  lineFrom: number;
  lineTo: number;
}

function formatIsoDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把行号列表合并为连续区段 [from, to]，便于画色带（减少 DOM 节点） */
function mergeContiguousLines(lines: number[]): Array<[number, number]> {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let from = sorted[0]!;
  let to = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === to + 1) {
      to = n;
    } else {
      out.push([from, to]);
      from = n;
      to = n;
    }
  }
  out.push([from, to]);
  return out;
}

/** 合并连续同 commit 的 blame 行为区块（Bitbucket 风格：一个 commit 一格） */
function groupBlameByCommit(blame: DiffBlameLine[]): BlameBlock[] {
  const sorted = [...blame].sort((a, b) => a.line - b.line);
  const blocks: BlameBlock[] = [];
  let cur: BlameBlock | null = null;
  for (const b of sorted) {
    if (cur && cur.commit === b.commit && cur.lineTo === b.line - 1) {
      cur.lineTo = b.line;
    } else {
      cur = {
        commit: b.commit,
        author: b.author,
        authorEmail: b.authorEmail,
        authorDate: b.authorDate,
        summary: b.summary,
        lineFrom: b.line,
        lineTo: b.line,
      };
      blocks.push(cur);
    }
  }
  return blocks;
}

/**
 * 统一(inline)视图下原始编辑器隐藏、删除行由 modified 编辑器以 view zone 呈现，故 old 侧评论/草稿
 * 不能再挂原始编辑器（会出现「大段空白、无内容」），须改挂 modified 编辑器。这里按 diff 行变更把
 * 「原始行号」映射成 modified 的 afterLineNumber：
 *  - 纯删除：删除块落在 modifiedStartLineNumber 之后 → 评论挂该行后；
 *  - 修改：对齐到 modified 块内对应行；
 *  - 上下文行（不在任何变更内）：按之前各变更的累计行数差平移。
 * diff 尚未计算（getLineChanges 为空）时退化为原行号 + 累计平移。
 */
function mapOriginalLineToModified(
  changes: readonly MonacoEditor.ILineChange[],
  origLine: number,
): number {
  let delta = 0;
  for (const ch of changes) {
    const oS = ch.originalStartLineNumber;
    const oE = ch.originalEndLineNumber;
    const mS = ch.modifiedStartLineNumber;
    const mE = ch.modifiedEndLineNumber;
    if (oE === 0) {
      // 纯插入（原始侧无行）：仅当插入点在 origLine 之前才计入偏移
      if (oS < origLine) delta += mE - mS + 1;
      continue;
    }
    if (oE < origLine) {
      // 变更整体在 origLine 之前：累计 modified 与 original 的行数差
      const oCount = oE - oS + 1;
      const mCount = mE === 0 ? 0 : mE - mS + 1;
      delta += mCount - oCount;
      continue;
    }
    if (oS <= origLine && origLine <= oE) {
      // origLine 落在本变更内
      if (mE === 0) return mS; // 纯删除：删除块在 modified 行 mS 之后
      return Math.min(mS + (origLine - oS), mE); // 修改：对齐 modified 块
    }
    break; // changes 有序，后续都在 origLine 之后
  }
  return origLine + delta;
}

/** 把 old 侧分桶按 diff 重映射到 modified 行号（统一视图用）。 */
function remapOldByLineToModified<T>(
  changes: readonly MonacoEditor.ILineChange[],
  oldByLine: Map<number, T[]>,
): Map<number, T[]> {
  const remapped = new Map<number, T[]>();
  for (const [origLine, items] of oldByLine) {
    const modLine = mapOriginalLineToModified(changes, origLine);
    remapped.set(modLine, [...(remapped.get(modLine) ?? []), ...items]);
  }
  return remapped;
}

export function DiffView({
  pr,
  renderSideBySide,
  showBlame,
  showWhitespace,
  pendingNav,
  onNavConsumed,
}: DiffViewProps) {
  const [files, setFiles] = useState<DiffChangedFile[] | null>(null);
  const [filesError, setFilesError] = useState<FormattedError | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // sidebar 模式：'tree' (文件树) / 'search' (跨文件搜索)，默认进文件树。
  // PR 切换 / tab 切走 + 重进 (条件渲染 unmount/remount) 时自然回到 'tree' —
  // 搜索状态不跨 PR / tab 保留，每次进 Diff 都是文件树视图
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree');
  useEffect(() => {
    setSidebarMode('tree');
  }, [pr.localId]);
  const [content, setContent] = useState<LoadedContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<FormattedError | null>(null);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [commentsError, setCommentsError] = useState<FormattedError | null>(null);
  const [blame, setBlame] = useState<{
    lines: DiffBlameLine[];
    changedLines: number[];
  } | null>(null);
  const [blameError, setBlameError] = useState<FormattedError | null>(null);
  // Monaco modified editor 的视图坐标 (用于 React overlay 渲染 blame 列)；
  // null = blame 关 / blame 数据没好 / editor 未挂载
  const [blameLayout, setBlameLayout] = useState<BlameLayout | null>(null);
  // 重试 token：递增触发对应 effect 重新跑，避免 setState 后立刻 invoke 拿不到最新的
  const [filesRetry, setFilesRetry] = useState(0);
  const [commentsRetry, setCommentsRetry] = useState(0);
  const [fileListWidth, setFileListWidth] = useState<number>(() => {
    const raw = localStorage.getItem('meebox.diffFileListWidth');
    const n = raw ? Number(raw) : DIFF_FILE_LIST_DEFAULT;
    return Math.min(
      DIFF_FILE_LIST_MAX,
      Math.max(DIFF_FILE_LIST_MIN, Number.isFinite(n) ? n : DIFF_FILE_LIST_DEFAULT),
    );
  });
  useEffect(() => {
    localStorage.setItem('meebox.diffFileListWidth', String(fileListWidth));
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

  // 切 PR 时清掉旧状态（含两个错误 + 选中文件 + 内容）
  useEffect(() => {
    setFiles(null);
    setFilesError(null);
    setSelectedKey(null);
    setContent(null);
    setContentError(null);
    setProgress(null);
    setComments([]);
    setCommentsError(null);
    setBlame(null);
    setBlameError(null);
  }, [pr.localId]);

  // 拉变更文件列表 (fatal 失败 → 整个 diff 区域 fallback)
  useEffect(() => {
    let cancelled = false;
    setFilesError(null);
    invoke('diff:listChangedFiles', { localId: pr.localId })
      .then((f) => {
        if (cancelled) return;
        setFiles(f);
        if (f.length > 0) setSelectedKey((prev) => prev ?? fileKey(f[0]!));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const fmt = formatBackendError(e);
          console.warn('diff:listChangedFiles failed', e);
          setFilesError(fmt);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pr.localId, filesRetry]);

  // 拉评论 (非 fatal：失败时给可重试 banner，不阻塞 diff 展示)
  useEffect(() => {
    let cancelled = false;
    setCommentsError(null);
    const fetchList = (force: boolean): void => {
      invoke('diff:listComments', { localId: pr.localId, force })
        .then((cs) => {
          if (!cancelled) setComments(cs);
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            const fmt = formatBackendError(e);
            console.warn('diff:listComments failed', e);
            setCommentsError(fmt);
          }
        });
    };
    fetchList(true);
    // 评论 reply / 状态变更后 main 端 broadcast comments:changed，inline view zone
    // 需要重拉刷新评论树 (含新 reply 嵌到父评论 .replies)
    const unsub = subscribe('comments:changed', (e) => {
      if (e.localId === pr.localId) fetchList(true);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pr.localId, commentsRetry]);

  const selected = files?.find((f) => fileKey(f) === selectedKey) ?? null;
  // M4 草稿池：跨 ChatPane / DiffView 共享 store；本组件需要它来渲染 inline zones
  const drafts = useDraftsForPr(pr.localId);

  // M4 autoEdit 触发器表：draft.id → "进入编辑模式" fn。供两个来源用：
  //   1. ChatPane → App.pendingDiffNav 跳转完后，目标 draft 自动 enter edit
  //   2. 行 hover '+' 创建 manual draft 后立即 enter edit (新草稿空 body 必须能输入)
  //
  // 用 ref-based fn 而不是 state token。token 方案曾导致 bug：用户取消 → auto save
  // → drafts store 变 → DiffView re-render → DraftZone unmount/mount → 新 instance
  // 看到 props token 仍非 undefined 又 setIsEditing(true) → 用户看似"取消没生效"。
  // ref-fn 调用纯副作用，不引发 re-render，不会循环触发
  const editTriggerFnsRef = useRef<Map<string, () => void>>(new Map());
  // pending trigger 兜底：triggerAutoEdit 调用时 DraftZone 还没 mount + register
  // (典型场景：hover '+' 创建后立即 trigger，drafts store 异步更新)。fn 不在 map
  // 时把 id 加 pending；registerEditTrigger 时如果发现自己 pending 立即 fire
  const pendingTriggersRef = useRef<Set<string>>(new Set());
  const registerEditTrigger = useCallback(
    (draftId: string, fn: (() => void) | null): void => {
      if (fn) {
        editTriggerFnsRef.current.set(draftId, fn);
        if (pendingTriggersRef.current.has(draftId)) {
          pendingTriggersRef.current.delete(draftId);
          fn();
        }
      } else {
        editTriggerFnsRef.current.delete(draftId);
      }
    },
    [],
  );
  const triggerAutoEdit = (draftId: string): void => {
    const fn = editTriggerFnsRef.current.get(draftId);
    if (fn) {
      fn();
    } else {
      pendingTriggersRef.current.add(draftId);
    }
  };

  // PR 切换清掉所有 trigger fn 引用 + pending (新 PR 的 DraftZone 会重新注册)
  useEffect(() => {
    editTriggerFnsRef.current.clear();
    pendingTriggersRef.current.clear();
  }, [pr.localId]);

  // M4 跳转消费：来自 ChatPane → App.pendingDiffNav。
  //   1. 找匹配 changed file → setSelectedKey 切到该文件
  //   2. 找对应草稿 (按 source.runId+findingId)，trigger autoEdit
  //   3. (后续 effect 处理) revealLine + 高亮
  //   4. ack 清掉 nav token
  //
  // 跨多个 effect 协调：本 effect 设 selectedKey + 找 targetDraftId；
  // 下游 effect 等 selected/diffEditor/drafts 就绪后 reveal + auto edit
  const [pendingScroll, setPendingScroll] = useState<{
    line: number;
    side: 'old' | 'new';
    draftId?: string;
  } | null>(null);
  useEffect(() => {
    if (!pendingNav || !files) return;
    const target = files.find(
      (f) => f.path === pendingNav.anchor.path || f.oldPath === pendingNav.anchor.path,
    );
    if (target) {
      setSelectedKey(fileKey(target));
    }
    // 查现有草稿；ChatPane 端已经懒创建过了，正常情况能找到。
    // 没传 runId/findingId (PublishReviewModal anchor 点击场景) → 直接跳过查找，
    // draftId 留 undefined → 下游 effect 不会触发 autoEdit，纯 navigate
    const matchingDraft =
      pendingNav.runId && pendingNav.findingId
        ? (drafts ?? []).find(
            (d) =>
              d.source !== undefined &&
              d.source.runId === pendingNav.runId &&
              d.source.findingId === pendingNav.findingId,
          )
        : undefined;
    setPendingScroll({
      line: pendingNav.anchor.startLine,
      side: 'new',
      draftId: matchingDraft?.id,
    });
    onNavConsumed?.();
    // drafts 不放 dep —— nav 进来时已 ack；后续 drafts 变化不该重复触发本逻辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, files, onNavConsumed]);

  // Bitbucket 评论附件 markdown 形如 `![alt](attachment:HASH)`；CommentNode 里把
  // `attachment:` 协议改写成此基址 + `/HASH`，让 <a> 能打开（点击走 Electron
  // setWindowOpenHandler 转 shell.openExternal，用户在系统浏览器看附件）。
  // 从 pr.url 解出 protocol+host 即可，pr.repo 提供 project/repo。
  const attachmentBase = useMemo(() => {
    try {
      const u = new URL(pr.url);
      return `${u.protocol}//${u.host}/projects/${pr.repo.projectKey}/repos/${pr.repo.repoSlug}/attachments`;
    } catch {
      return null;
    }
  }, [pr.url, pr.repo.projectKey, pr.repo.repoSlug]);

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

  // 给文件树用：path → 该文件下的待发布草稿数 (pending + edited)。
  // 跟 PR header "提交评审 (N)" 同口径：rejected (用户决断不发) / posted (已发，
  // 已经在 comments chip 里算了) 都排除。让用户在文件树扫一眼就知道哪些文件还
  // 攒了未发的草稿。oldPath 别名兜底跟 commentCountByPath 一致 (renamed 文件)
  const draftCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    if (!files || !drafts) return m;
    const publishable = drafts.filter(
      (d) => d.status === 'pending' || d.status === 'edited',
    );
    for (const f of files) {
      const n = publishable.filter(
        (d) =>
          d.anchor.path === f.path || (f.oldPath && d.anchor.path === f.oldPath),
      ).length;
      if (n > 0) m.set(f.path, n);
    }
    return m;
  }, [files, drafts]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContent(null);
    setContentError(null);
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
        if (!cancelled) {
          console.warn('diff:getFileContent failed', e);
          setContentError(formatBackendError(e));
        }
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
      setBlameError(null);
      return;
    }
    if (selected.status === 'deleted') {
      setBlame(null);
      setBlameError(null);
      return;
    }
    let cancelled = false;
    setBlameError(null);
    invoke('diff:getBlame', { localId: pr.localId, path: selected.path })
      .then((b) => {
        if (!cancelled) setBlame(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn('[blame:fetch] failed', e);
          setBlame(null);
          setBlameError(formatBackendError(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showBlame, selected, content, pr.localId]);

  // Blame 走独立 React 列（Bitbucket 风格），不在 Monaco DOM 里。只需要从 Monaco
  // 同步 lineHeight / scrollTop / viewportHeight，BlameColumn 自己用 absolute
  // 子项画 row 并按 scrollTop 平移。
  useEffect(() => {
    if (!diffEditor || !showBlame || !blame || blame.lines.length === 0) {
      setBlameLayout(null);
      return;
    }
    const modifiedEditor = diffEditor.getModifiedEditor();
    const update = (): void => {
      const dom = modifiedEditor.getDomNode();
      if (!dom) return;
      const layout = modifiedEditor.getLayoutInfo();
      const lh = modifiedEditor.getOption(MonacoEditorNs.EditorOption.lineHeight);
      setBlameLayout({
        viewportHeight: layout.height,
        lineHeight: typeof lh === 'number' && lh > 0 ? lh : 19,
        scrollTop: modifiedEditor.getScrollTop(),
      });
    };
    update();
    // 初次 mount 时 layout 可能还在计算，下一 tick 再算一次
    const t = setTimeout(update, 0);
    const subs = [
      modifiedEditor.onDidScrollChange(update),
      modifiedEditor.onDidLayoutChange(update),
    ];
    const ro = new ResizeObserver(update);
    const dom = modifiedEditor.getDomNode();
    if (dom) ro.observe(dom);
    return () => {
      clearTimeout(t);
      for (const s of subs) s.dispose();
      ro.disconnect();
    };
  }, [diffEditor, showBlame, blame]);

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
      const lineHeight = editorInst.getOption(MonacoEditorNs.EditorOption.lineHeight);
      editorInst.changeViewZones((accessor) => {
        for (const [line, cs] of byLine) {
          // 跟 DraftZone 一样的双层结构：dom 是 monaco wrapper (设 height inline)，
          // inner 是真实视觉容器；RO observe(inner) → 内嵌图片异步加载 / 嵌套评论
          // 展开后内容变高时同步 zoneObj.heightInPx + layoutZone，zone 跟着撑开
          const dom = document.createElement('div');
          dom.className = 'monaco-comment-zone';

          // stopPropagation 必须先于 createRoot 注册到 dom（外层），但 inner 上
          // 的 stopPropagation 必须**晚于** createRoot — 跟 DraftZone 同顺序，
          // 否则 React 18 在 inner 上的 event delegation 受影响导致 onClick 不 fire。
          // bubble 阶段 stop 让 target 上的 React handler 先 fire 再阻断冒泡到 editor
          const stopAll = (e: Event): void => e.stopPropagation();
          // 注意：不拦 wheel —— 评论区 auto-size 无内部滚动，滚轮要冒泡给 Monaco 滚编辑器，
          // 否则鼠标停在评论上时整个 diff 无法滚动（stopPropagation 会吃掉滚动）。
          for (const evt of ['mousedown', 'mouseup', 'click', 'dblclick']) {
            dom.addEventListener(evt, stopAll);
          }

          const inner = document.createElement('div');
          inner.className = 'monaco-comment-zone-inner';
          dom.appendChild(inner);

          const root = createRoot(inner);
          root.render(
            <CommentZone
              comments={cs}
              connectionId={pr.connectionId}
              attachmentBase={attachmentBase}
              prLocalId={pr.localId}
            />,
          );

          const initialPx = Math.max(estimateZoneHeight(cs) * lineHeight, lineHeight * 3);
          const zoneObj: MonacoEditor.IViewZone = {
            afterLineNumber: line,
            heightInPx: initialPx,
            domNode: dom,
          };
          const zoneId = accessor.addZone(zoneObj);
          zoneRefs.push({ editor: editorInst, zoneId, dom, root });

          const syncHeight = (): void => {
            const next = inner.offsetHeight;
            if (next <= 0) return;
            if (Math.abs(next - (zoneObj.heightInPx ?? 0)) < 1) return;
            zoneObj.heightInPx = next;
            try {
              editorInst.changeViewZones((acc) => acc.layoutZone(zoneId));
            } catch {
              /* editor disposed */
            }
          };
          const ro = new ResizeObserver(() => requestAnimationFrame(syncHeight));
          ro.observe(inner);
          requestAnimationFrame(syncHeight);
          setTimeout(syncHeight, 200);

          // 宽度策略 (跟 DraftZone 同套): BoundingClientRect 算 inner 视口宽度
          // 让评论框不超 editor 边界；多点 sync + 监听 layout/diff/RO 覆盖各时机
          const editorDomNode = editorInst.getDomNode();
          const applyInnerLayout = (): void => {
            if (!editorDomNode) return;
            const editorRect = editorDomNode.getBoundingClientRect();
            if (editorRect.width <= 0) return;
            const domRect = dom.getBoundingClientRect();
            const sbW = editorInst.getLayoutInfo().verticalScrollbarWidth ?? 0;
            const innerLeft = domRect.width > 0 ? domRect.left : editorRect.left;
            const innerRight = editorRect.right - sbW;
            const w = Math.max(0, innerRight - innerLeft);
            if (w > 0) {
              inner.style.marginLeft = '0';
              inner.style.width = `${w}px`;
              inner.style.maxWidth = `${w}px`;
            }
          };
          applyInnerLayout();
          requestAnimationFrame(applyInnerLayout);
          setTimeout(applyInnerLayout, 50);
          setTimeout(applyInnerLayout, 200);
          setTimeout(applyInnerLayout, 500);
          const layoutDisp = editorInst.onDidLayoutChange(applyInnerLayout);
          const diffDisp = diffEditor.onDidUpdateDiff(() =>
            requestAnimationFrame(applyInnerLayout),
          );
          const editorRO = editorDomNode
            ? new ResizeObserver(() => requestAnimationFrame(applyInnerLayout))
            : null;
          if (editorDomNode && editorRO) editorRO.observe(editorDomNode);

          // 横向滚动同步 (跟 DraftZone 同套): translateX(scrollLeft) 反向抵消 monaco
          // view zone 跟随 .lines-content 左移，评论 stick 视口位置
          const applyScroll = (): void => {
            inner.style.transform = `translateX(${editorInst.getScrollLeft()}px)`;
          };
          applyScroll();
          const scrollDisp = editorInst.onDidScrollChange(applyScroll);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__commentRO = ro;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__commentLayoutDisp = layoutDisp;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__commentDiffDisp = diffDisp;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__commentEditorRO = editorRO;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__commentScrollDisp = scrollDisp;

          // inner 上的 stopPropagation 必须晚于 createRoot 注册（双层防御 + 兼容
          // React 18 在 inner 上的 event delegation 初始化顺序）
          // 注意：不拦 wheel —— 评论区 auto-size 无内部滚动，滚轮要冒泡给 Monaco 滚编辑器，
          // 否则鼠标停在评论上时整个 diff 无法滚动（stopPropagation 会吃掉滚动）。
          for (const evt of ['mousedown', 'mouseup', 'click', 'dblclick']) {
            inner.addEventListener(evt, stopAll);
          }
        }
      });
    };

    // 并排视图：old 侧挂原始编辑器；统一视图：原始编辑器隐藏，old 侧改挂 modified 编辑器对应行。
    if (renderSideBySide) {
      addZonesFor(originalEditor, oldByLine);
    } else if (oldByLine.size > 0) {
      addZonesFor(modifiedEditor, remapOldByLineToModified(diffEditor.getLineChanges() ?? [], oldByLine));
    }
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
      for (const z of zoneRefs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ro = (z.dom as any).__commentRO as ResizeObserver | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ld = (z.dom as any).__commentLayoutDisp as { dispose(): void } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dd = (z.dom as any).__commentDiffDisp as { dispose(): void } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ero = (z.dom as any).__commentEditorRO as ResizeObserver | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sd = (z.dom as any).__commentScrollDisp as { dispose(): void } | undefined;
        try {
          ro?.disconnect();
          ld?.dispose();
          dd?.dispose();
          ero?.disconnect();
          sd?.dispose();
        } catch {
          /* ignore */
        }
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
  }, [
    diffEditor,
    comments,
    content,
    selected,
    pr.connectionId,
    attachmentBase,
    pr.localId,
    renderSideBySide,
  ]);

  // M4: 内联草稿 view zones (蓝底，editable)。跟 comments 同套机制：
  // - filter drafts by selected.path / oldPath
  // - 按 anchor.side (old / new) 分桶
  // - addZone + createRoot 渲染 DraftZone 组件
  // - DraftZone 内 isEditing state 由组件自管；onSave / onDelete 调 IPC mutators
  //
  // 不渲染 rejected (用户决断不发，默认隐藏)、posted (远端评论已由 CommentZone
  // 接管，本地草稿再渲染就跟远端评论视觉重复)。
  // 现版本发布路径不再产生 posted (drafts:publishBatch 成功直接删本地)，但旧
  // 测试可能在本地状态文件里留下 posted 数据 — 这里过滤是双保险，让历史 posted
  // 草稿不再出现在 DiffView 里
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const fileDrafts = (drafts ?? []).filter((d) => {
      if (d.status === 'rejected' || d.status === 'posted') return false;
      return d.anchor.path === selected.path || selected.oldPath === d.anchor.path;
    });
    if (fileDrafts.length === 0) return;

    const oldByLine = new Map<number, ReviewDraft[]>();
    const newByLine = new Map<number, ReviewDraft[]>();
    for (const d of fileDrafts) {
      const target = d.anchor.side === 'old' ? oldByLine : newByLine;
      // 用 startLine 作为 zone 行号 — finding 跨多行 (startLine=403, endLine=425)
      // 时 zone 紧贴 startLine 下方，跟 nav reveal 的高亮行视觉一致；之前用 endLine
      // 让 zone 出现在 finding 段末尾 (425 后)，高亮行在起始 (403)，跨 23 行错位
      const arr = target.get(d.anchor.startLine) ?? [];
      arr.push(d);
      target.set(d.anchor.startLine, arr);
    }

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const zoneRefs: Array<{
      editor: MonacoEditor.ICodeEditor;
      zoneId: string;
      dom: HTMLElement;
      root: Root;
    }> = [];

    const addZonesFor = (
      editorInst: MonacoEditor.ICodeEditor,
      byLine: Map<number, ReviewDraft[]>,
    ): void => {
      editorInst.changeViewZones((accessor) => {
        for (const [line, ds] of byLine) {
          // 同一行多条草稿叠加挂一个 zone (height 累加；每条 DraftZone 自渲染)
          const dom = document.createElement('div');
          dom.className = 'monaco-draft-zone';

          // 经典 Monaco view zone 坑：editor 自带 mousedown listener 把整个 zone
          // 区域当作 "editor mouse target"，吞掉冒泡到 DOM 的事件 → zone 内 textarea
          // 收不到 focus、button 点不响应。在 dom 容器上 stopPropagation 一组关键事件，
          // 让 monaco 不再接管 zone 内的 user input。
          //
          // **必须是 bubble 阶段** (第三参数省略 / false)。capture 阶段拦截会在事件
          // 到达 button/textarea **之前**就阻断，React onClick / onKeyDown 根本不
          // 触发 (取消按钮点了没反应正是这个 bug)。bubble 阶段让 target 上的 React
          // handler 先 fire，再阻止冒泡到 editor
          const stopAll = (e: Event): void => e.stopPropagation();
          for (const evt of [
            'mousedown',
            'mouseup',
            'click',
            'dblclick',
            'keydown',
            'keyup',
            'wheel',
            'contextmenu',
          ]) {
            dom.addEventListener(evt, stopAll);
          }

          // 高度策略：保留 zone 对象引用，ResizeObserver 回调里改 zone.heightInPx
          // 后 layoutZone。Monaco 的 layoutZone(zoneId) 重新读 zone.heightInPx；
          // 必须自己写回新值。
          //
          // **关键坑**：Monaco 直接把 `style.height = <heightInPx>px` 写到 dom 元素
          // 上 (dom 就是 zone wrapper，monaco 不另套一层)，覆盖我们设的 height:auto。
          // 所以 dom.offsetHeight 永远 = zoneObj.heightInPx → 用 offsetHeight 测会
          // 产生 next === zoneObj.heightInPx 自循环，永远不更新。
          //
          // 我们插一层内部容器 inner，inner 不受 monaco 控制 → inner.offsetHeight
          // 才是真实内容高度。dom 自己保持 monaco 写的尺寸，但 overflow:visible，
          // inner 内容自然撑开；measure inner 同步回 zoneObj.heightInPx
          const inner = document.createElement('div');
          inner.className = 'monaco-draft-zone-inner';
          // 宽度 + 位置策略（跟 Bitbucket / GitHub inline 评论对齐）：
          //   inner.marginLeft = contentLeft  (跨过 line number / glyph margin，
          //                                   评论框起点对齐代码区起点)
          //   inner.width      = contentWidth (代码区宽度；contentWidth 已减掉
          //                                   monaco scrollbar / minimap 占用)
          //
          // 横向滚动行为：代码区 viewport 在 editor DOM 内的位置不随 scrollLeft 变
          // (.view-lines 内部滚，外部 viewport 边界不动)，所以静态对齐就够，不需要
          // 跟 scrollLeft 联动。
          //
          // 防御：editorDomNode.clientWidth 当兜底上限，防 layoutInfo 异常时
          // contentWidth 算出超界 (之前用户报"跨到 ChatPane"症状)。clientWidth
          // 含 monaco overlay scrollbar 那段区域，要再减 verticalScrollbarWidth
          //
          // 双触发：editor.onDidLayoutChange (几何变化) + ResizeObserver 观察 editor
          // DOM (窗口 / 分隔条 resize)，覆盖率不重叠
          const editorDomNode = editorInst.getDomNode();
          const applyInnerLayout = (): void => {
            if (!editorDomNode) return;
            const editorRect = editorDomNode.getBoundingClientRect();
            if (editorRect.width <= 0) return; // editor 还没 layout，等下次 trigger
            const domRect = dom.getBoundingClientRect();
            const sbW = editorInst.getLayoutInfo().verticalScrollbarWidth ?? 0;
            // 用 BoundingClientRect 拿浏览器实际渲染坐标 — clientWidth / layoutInfo.width
            // 在 monaco inline (unified) view 下偶发给出超出 editor 视觉边界的值，
            // 用户实测评论框跨到 ChatPane 区域。Rect 是 layout 后的真实像素坐标，
            // 永远不超 editor 视觉边界。
            //
            // 算法：inner 从 dom 起点 (左 0) 开始，最远延伸到 editor 视觉右边界
            // - verticalScrollbar。dom 还没挂到 DOM 树时 rect.width=0，用 editor
            // 左边界兜底
            const innerLeft = domRect.width > 0 ? domRect.left : editorRect.left;
            const innerRight = editorRect.right - sbW;
            const w = Math.max(0, innerRight - innerLeft);
            if (w > 0) {
              inner.style.marginLeft = '0';
              inner.style.width = `${w}px`;
              inner.style.maxWidth = `${w}px`;
            }
          };
          applyInnerLayout();
          // 多个时间点兜底：切换文件 + autoEdit 跳转时 monaco 在算 diff / 文件 mount
          // 还没完，editor 的 getBoundingClientRect 给的不是稳定 layout (用户实测
          // 跳转新文件评论框宽度撑爆，resize 后恢复)。多次 sync 覆盖 layout 过程
          requestAnimationFrame(applyInnerLayout);
          setTimeout(applyInnerLayout, 50);
          setTimeout(applyInnerLayout, 200);
          setTimeout(applyInnerLayout, 500);
          const layoutDisp = editorInst.onDidLayoutChange(applyInnerLayout);
          // diff 计算完成事件 — 切换文件后 monaco 算 diff 时 layout 可能还在变，
          // 算完才是稳定状态。挂这个监听让评论框宽度跟最终 layout 同步
          const diffDisp = diffEditor.onDidUpdateDiff(() =>
            requestAnimationFrame(applyInnerLayout),
          );
          const editorRO = editorDomNode
            ? new ResizeObserver(() => requestAnimationFrame(applyInnerLayout))
            : null;
          if (editorDomNode && editorRO) editorRO.observe(editorDomNode);

          // 横向滚动同步：monaco view zone dom 在 .lines-content 内会跟 scrollLeft
          // 一起左移 (用户实测：横滚后评论框 chip 被裁出 viewport)。给 inner 加
          // transform translateX(scrollLeft) 反向抵消，评论框就 stick 在 viewport
          // 内的相对位置不动 (跟 Bitbucket / GitHub inline 评论行为一致)
          const applyScroll = (): void => {
            inner.style.transform = `translateX(${editorInst.getScrollLeft()}px)`;
          };
          applyScroll();
          const scrollDisp = editorInst.onDidScrollChange(applyScroll);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__draftLayoutDisp = layoutDisp;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__draftDiffDisp = diffDisp;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__draftEditorRO = editorRO;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__draftScrollDisp = scrollDisp;
          // inner 也 stopPropagation 一份 (双层防御)，确保即便 dom 的 listener 被
          // monaco 某种方式绕过，inner 仍能吞掉事件不让 editor 自动接管
          for (const evt of [
            'mousedown',
            'mouseup',
            'click',
            'dblclick',
            'keydown',
            'keyup',
            'wheel',
            'contextmenu',
          ]) {
            inner.addEventListener(evt, stopAll);
          }
          dom.appendChild(inner);

          const reactRoot = createRoot(inner);
          reactRoot.render(
            <DraftZoneList
              drafts={ds}
              prLocalId={pr.localId}
              registerEditTrigger={registerEditTrigger}
            />,
          );

          const initialPx = Math.max(ds.length * 60, 80);
          const zoneObj: MonacoEditor.IViewZone = {
            afterLineNumber: line,
            heightInPx: initialPx,
            domNode: dom,
          };
          const zoneId = accessor.addZone(zoneObj);
          zoneRefs.push({ editor: editorInst, zoneId, dom, root: reactRoot });

          // 高度同步：直接 mutate zoneObj.heightInPx + layoutZone(id)。
          // removeZone+addZone 在 textarea 拖拽 resize 时每帧调用会引起 zone 重建
          // 抖动，鼠标跟不上手 (用户实测)。layoutZone 是轻量操作，先 mutate
          // delegate.heightInPx 再 layoutZone 即可让 monaco 重新计算 viewModel
          // whitespace，原"layoutZone 不响应"的判断不成立——之前是因为没改 heightInPx
          const syncHeight = (): void => {
            const next = inner.offsetHeight;
            if (next <= 0) return;
            if (Math.abs(next - (zoneObj.heightInPx ?? 0)) < 1) return;
            zoneObj.heightInPx = next;
            try {
              editorInst.changeViewZones((acc) => {
                acc.layoutZone(zoneId);
              });
            } catch {
              /* editor disposed */
            }
          };

          // ResizeObserver 跟踪 inner 高度变化 (DraftZone read↔edit 切换、textarea
          // resize)。requestAnimationFrame 避开"回调里同步 layout 又触发 RO"循环
          const ro = new ResizeObserver(() => {
            requestAnimationFrame(syncHeight);
          });
          ro.observe(inner);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dom as any).__draftRO = ro;
          // 多个时间点 sync 兜底覆盖布局抖动 / React 多阶段 render
          requestAnimationFrame(syncHeight);
          setTimeout(syncHeight, 50);
          setTimeout(syncHeight, 200);
        }
      });
    };

    // 并排视图：old 侧挂原始编辑器；统一视图：原始编辑器隐藏，old 侧改挂 modified 编辑器对应行。
    if (renderSideBySide) {
      addZonesFor(originalEditor, oldByLine);
    } else if (oldByLine.size > 0) {
      addZonesFor(modifiedEditor, remapOldByLineToModified(diffEditor.getLineChanges() ?? [], oldByLine));
    }
    addZonesFor(modifiedEditor, newByLine);

    return () => {
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
      // 先 disconnect ResizeObserver + dispose layout listener，再 unmount root，
      // 避免 unmount 引起的 DOM 高度回落触发观察回调 + layoutZone(disposed editor) 报错
      for (const z of zoneRefs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ro = (z.dom as any).__draftRO as ResizeObserver | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ld = (z.dom as any).__draftLayoutDisp as { dispose(): void } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dd = (z.dom as any).__draftDiffDisp as { dispose(): void } | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ero = (z.dom as any).__draftEditorRO as ResizeObserver | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sd = (z.dom as any).__draftScrollDisp as { dispose(): void } | undefined;
        try {
          ro?.disconnect();
          ld?.dispose();
          dd?.dispose();
          ero?.disconnect();
          sd?.dispose();
        } catch {
          /* ignore */
        }
      }
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
    // 不依赖 autoEditTokens (已移除 state) / registerEditTrigger (稳定的 useCallback)
    // — 避免 trigger 引发 zone 重建带来的 DraftZone unmount/mount，根除取消后重入
    // edit 模式的 race
  }, [diffEditor, drafts, content, selected, pr.localId, registerEditTrigger, renderSideBySide]);

  // M4 行 hover '+' 新建 manual 草稿：modifiedEditor (head 侧) 上加 mousemove +
  // mousedown 监听。已有评论 / 草稿的行不重复出 + glyph，避免误触。
  //
  // 视觉：hover 行的 line decoration 显示淡蓝 '+'，鼠标 hover glyph 时浓蓝。
  // 点击 → drafts:create + autoEdit 触发立即进入编辑。
  //
  // **Platform policy 过滤**：Bitbucket 只允许 hunk 内的行加 inline comment；GitHub/GitLab
  // 宽松。从 diffEditor.getLineChanges() 拿 hunks，policy 判断每行是否 allowed。
  // 不允许的行不画 glyph、点击也不创建草稿（避免后续 publishInline 时被 Bitbucket 400）
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    // 已有评论 / 草稿的 head 侧行号集合 (避免在这些行额外显示 +)
    const occupied = new Set<number>();
    for (const c of comments) {
      if (c.anchor && c.anchor.side === 'new') occupied.add(c.anchor.line);
    }
    for (const d of drafts ?? []) {
      if (d.status === 'rejected') continue;
      // 跟 zone 创建时一致用 startLine — 之前用 endLine 会让 hover '+' 把行 403
      // (finding 起始) 当未占用错画 +；finding 跨多行场景下两个 + 同时出现
      if (d.anchor.side === 'new') occupied.add(d.anchor.startLine);
    }

    // 把 monaco ILineChange[] 翻成 DiffHunkRange[]。LineChange 的 EndLineNumber=0
    // 表示该侧无对应（纯增/纯删），翻成 null range。
    //
    // **关键**：useEffect 首次执行时 monaco diff 还在异步计算，getLineChanges() 可能
    // 返回 null/[] → 用 Bitbucket policy 严格判会让"所有行都不允许" → 用户看不到任何 +。
    // 监听 onDidUpdateDiff 在 diff 算完后刷新 hunks (mutable let，闭包引用最新值)。
    // 同时：hunks 为空时**兜底允许**（视为 policy 暂不可用），等 update 事件来再收紧
    const policy = policyForPlatform(pr.platform);
    const computeHunks = (): DiffHunkRange[] => {
      const lineChanges = diffEditor.getLineChanges() ?? [];
      return lineChanges.map((c) => ({
        original:
          c.originalEndLineNumber >= c.originalStartLineNumber &&
          c.originalEndLineNumber > 0
            ? { start: c.originalStartLineNumber, end: c.originalEndLineNumber }
            : null,
        modified:
          c.modifiedEndLineNumber >= c.modifiedStartLineNumber &&
          c.modifiedEndLineNumber > 0
            ? { start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber }
            : null,
      }));
    };
    let hunks = computeHunks();
    const diffUpdateDisp = diffEditor.onDidUpdateDiff(() => {
      hunks = computeHunks();
    });

    /** 兜底允许：hunks 还没算完（空数组）就一律允许，避免初始"什么都点不出来"。
     *  正常加载完 hunks 非空后才走 policy 严格判 */
    const isAllowed = (line: number): boolean =>
      hunks.length === 0 || policy.isLineAllowed(hunks, 'new', line);

    let hoverLine: number | null = null;
    const collection = modifiedEditor.createDecorationsCollection([]);

    const setHover = (line: number | null): void => {
      hoverLine = line;
      collection.set(
        line === null || occupied.has(line) || !isAllowed(line)
          ? []
          : [
              {
                range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
                options: {
                  isWholeLine: false,
                  // 用 glyphMarginClassName 跟 commentZone (远端评论) 一致 —— 渲染在
                  // editor 最左 glyph margin 列 (跟 GitHub 评论 "+" 位置惯例一致)。
                  // 之前试过 linesDecorationsClassName 但挤压 line number 列体验更差，
                  // 撤回到这里。DiffEditor 已开启 glyphMargin:true 让那一列宽到足够装 +
                  glyphMarginClassName: 'monaco-draft-add-glyph',
                  glyphMarginHoverMessage: { value: '点击新增评论' },
                },
              },
            ],
      );
    };

    const onMove = modifiedEditor.onMouseMove((e) => {
      const t = e.target;
      if (
        (t.type === MonacoEditorNs.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          t.type === MonacoEditorNs.MouseTargetType.GUTTER_LINE_NUMBERS) &&
        t.position
      ) {
        const ln = t.position.lineNumber;
        if (hoverLine !== ln) setHover(ln);
      } else if (hoverLine !== null) {
        setHover(null);
      }
    });

    const onLeave = modifiedEditor.onMouseLeave(() => {
      if (hoverLine !== null) setHover(null);
    });

    const onDown = modifiedEditor.onMouseDown((e) => {
      const t = e.target;
      if (
        t.type === MonacoEditorNs.MouseTargetType.GUTTER_GLYPH_MARGIN &&
        t.position &&
        !occupied.has(t.position.lineNumber) &&
        isAllowed(t.position.lineNumber)
      ) {
        const line = t.position.lineNumber;
        void (async () => {
          try {
            const created = await invoke('drafts:create', {
              localId: pr.localId,
              draft: {
                anchor: {
                  path: selected.path,
                  startLine: line,
                  endLine: line,
                  side: 'new',
                },
                body: '',
                origin: 'manual',
                status: 'pending',
              },
            });
            // 新建后立即触发 auto edit，让用户能马上输入
            triggerAutoEdit(created.id);
          } catch {
            // 静默；UI 上没出 zone 就视为没创建成功
          }
        })();
      }
    });

    return () => {
      onMove.dispose();
      onLeave.dispose();
      onDown.dispose();
      diffUpdateDisp.dispose();
      try {
        collection.clear();
      } catch {
        /* editor disposed */
      }
    };
  }, [diffEditor, content, selected, drafts, comments, pr.localId, pr.platform]);

  // M4 nav 完成消费：scroll + highlight + autoEdit 关联草稿。等 selected 文件
  // 切换 + content 加载 + diffEditor 就绪 + drafts hydrated 完，再 revealLine。
  // pendingScroll 来自 nav effect (setSelectedKey 同时设的)；reveal 后清空
  useEffect(() => {
    if (!pendingScroll || !diffEditor || !content || !selected) return;
    if (selected.path !== pendingScroll.draftId) {
      // 这条 effect 在 selected 切换瞬间会先跑一次还没加载到目标文件 → 等 content 来
      // 用 selected.path 跟 pendingScroll 的 anchor.path 关联间接判断
    }
    const editor =
      pendingScroll.side === 'old' ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();

    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;
    const reveal = () => {
      // onDidUpdateDiff 可能多次触发，只跳一次
      if (revealed) return;
      revealed = true;
      // 居中滚到目标行
      editor.revealLineInCenter(pendingScroll.line);
      // 短暂高亮：300ms 黄底脉冲
      const collection = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: pendingScroll.line,
            startColumn: 1,
            endLineNumber: pendingScroll.line,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'monaco-draft-highlight-flash',
          },
        },
      ]);
      highlightTimer = setTimeout(() => {
        try {
          collection.clear();
        } catch {
          /* editor disposed */
        }
      }, 800);
      // 同时触发关联草稿的 autoEdit (DraftZone 自动 enter edit mode)
      if (pendingScroll.draftId) {
        triggerAutoEdit(pendingScroll.draftId);
      }
      setPendingScroll(null);
    };

    // Monaco diff 是异步算的：models 挂上(onMount)后还要等 diff 计算 +
    // hideUnchangedRegions 折叠布局完成，行号到视口位置的映射才稳定。此时
    // 直接 revealLine 会定位到旧布局/错误位置。getLineChanges() 在算完前
    // 返回 null、算完返回数组 → 已就绪直接跳，否则等 onDidUpdateDiff 首次触发。
    if (diffEditor.getLineChanges() != null) {
      reveal();
      return () => {
        if (highlightTimer) clearTimeout(highlightTimer);
      };
    }
    const disposable = diffEditor.onDidUpdateDiff(reveal);
    return () => {
      disposable.dispose();
      if (highlightTimer) clearTimeout(highlightTimer);
    };
  }, [pendingScroll, diffEditor, content, selected]);

  if (filesError) {
    return (
      <BackendErrorView
        err={filesError}
        scope="拉取变更文件列表失败"
        onRetry={() => setFilesRetry((n) => n + 1)}
      />
    );
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
        {/* header 一直显示。tree 模式右侧是"搜索"图标 (进搜索)；search 模式
            换"文件树"图标 (明示这是回到文件树的入口)，比"再点一次同图标切回"
            语义清晰 */}
        <div className="diff-file-list-header">
          <span>
            {sidebarMode === 'search' ? '搜索变更内容' : `${String(files.length)} 个文件`}
          </span>
          <button
            type="button"
            className="diff-file-list-search-btn"
            onClick={() => setSidebarMode((m) => (m === 'search' ? 'tree' : 'search'))}
            title={sidebarMode === 'search' ? '返回文件树' : '搜索变更内容 (head + base)'}
            aria-label={sidebarMode === 'search' ? '返回文件树' : '搜索'}
          >
            {sidebarMode === 'search' ? <FileTreeIcon /> : <SearchIcon />}
          </button>
        </div>
        {sidebarMode === 'tree' && (
          <FileTree
            files={files}
            selectedKey={selectedKey}
            commentCountByPath={commentCountByPath}
            draftCountByPath={draftCountByPath}
            onSelect={(f) => setSelectedKey(fileKey(f))}
          />
        )}
        {sidebarMode === 'search' && (
          <DiffSearchPanel
            files={files}
            prLocalId={pr.localId}
            onJumpToMatch={(f, line, side) => {
              setSelectedKey(fileKey(f));
              // 复用现有 pendingScroll 机制定位行 — 不带 draftId 仅 navigate
              setPendingScroll({ line, side });
            }}
            onExit={() => setSidebarMode('tree')}
          />
        )}
        <div
          className="diff-file-list-resize-handle"
          onMouseDown={startFileListResize}
          title="拖动调整文件树宽度"
          aria-label="resize diff file list"
        />
      </aside>
      <div className="diff-content">
        {commentsError && (
          <BackendErrorBanner
            err={commentsError}
            scope="拉取评论失败"
            onRetry={() => setCommentsRetry((n) => n + 1)}
            onDismiss={() => setCommentsError(null)}
          />
        )}
        {contentError && (
          <BackendErrorBanner
            err={contentError}
            scope={selected ? `读取 ${selected.path} 内容失败` : '读取文件内容失败'}
            onDismiss={() => setContentError(null)}
          />
        )}
        {showBlame && blameError && (
          <BackendErrorBanner
            err={blameError}
            scope={selected ? `${selected.path} blame 失败` : 'blame 失败'}
            onDismiss={() => setBlameError(null)}
          />
        )}
        {selected && (
          <div className="diff-pane-wrapper">
            {showBlame && blame && blameLayout && diffEditor && (
              <BlameColumn
                blame={blame}
                layout={blameLayout}
                connectionId={pr.connectionId}
                diffEditor={diffEditor}
              />
            )}
            <ErrorBoundary
              label="DiffPane"
              fallback={(err, reset) => (
                <div className="diff-empty diff-error">
                  <p>diff 渲染失败：{err.message}</p>
                  <p className="muted" style={{ marginTop: 8 }}>
                    切换文件 / 重试通常能恢复。底层异常已记录到 console。
                  </p>
                  <button type="button" className="btn btn-sm" onClick={reset}>
                    重试
                  </button>
                </div>
              )}
            >
              <DiffPane
                key={`${selected.path}|${selected.oldPath ?? ''}`}
                file={selected}
                content={content}
                loading={contentLoading}
                renderSideBySide={renderSideBySide}
                showBlame={showBlame}
                showWhitespace={showWhitespace}
                onMount={setDiffEditor}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 估算 view zone 高度（行数）。每段评论 = header(avatar+name+date, 1.3 行) + body
 * 字数 / 80 行向上取整。回复递归计算，每条 reply 多 0.3 行 (margin/border)。
 * 同行多评论叠加，最后顶天 32 行避免独吞屏幕。
 */
function estimateZoneHeight(comments: PrComment[]): number {
  let h = 1; // 上下 padding
  for (const c of comments) h += commentHeight(c) + 0.3; // item 间分隔
  return Math.min(Math.ceil(h), 32);
}

function commentHeight(c: PrComment): number {
  let h = 1.3 + Math.max(1, Math.ceil(c.body.length / 80));
  for (const r of c.replies) h += commentHeight(r) + 0.3;
  return h;
}

/**
 * 同行多条草稿的容器；每条独立 DraftZone (read/edit 各自维护)，组件间用 hr 分隔。
 * onSave / onDelete 在这里调 IPC drafts:update / drafts:delete；写盘后 main 端
 * 广播 drafts:changed 事件 → drafts-store 重拉 → DiffView 顶层 useEffect 重建
 * zones (此组件随之 unmount/remount)。
 */
function DraftZoneList({
  drafts,
  prLocalId,
  registerEditTrigger,
}: {
  drafts: ReviewDraft[];
  prLocalId: string;
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
}) {
  const onSave = async (draftId: string, body: string): Promise<void> => {
    await invoke('drafts:update', {
      localId: prLocalId,
      draftId,
      patch: { body },
    });
  };
  const onDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: prLocalId, draftId });
  };
  // 单条发布：复用 drafts:publishBatch handler，传 [draftId] 单元素。这样跟
  // PublishReviewModal 的批量路径共用同一份 main 端逻辑 (anchor 映射 / posted
  // 回写 / force-refresh 评论 / 失败收集都一致)，行为可预测，未来改任一处不会
  // 让两条路径分叉
  const onPublish = async (
    draftId: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const resp = await invoke('drafts:publishBatch', {
      localId: prLocalId,
      draftIds: [draftId],
    });
    const r = resp.results[0];
    if (!r) return { ok: false, error: 'main 端未返回结果' };
    return { ok: r.ok, error: r.error };
  };
  return (
    <div className="draft-zone-list">
      {drafts.map((d, i) => (
        <div
          key={d.id}
          className={`draft-zone-item${i > 0 ? ' draft-zone-item-divider' : ''}`}
        >
          <DraftZone
            draft={d}
            registerEditTrigger={registerEditTrigger}
            onSave={(body) => onSave(d.id, body)}
            onDelete={() => onDelete(d.id)}
            onPublish={() => onPublish(d.id)}
          />
        </div>
      ))}
    </div>
  );
}

function CommentZone({
  comments,
  connectionId,
  attachmentBase,
  prLocalId,
}: {
  comments: PrComment[];
  connectionId: string;
  attachmentBase: string | null;
  prLocalId: string;
}) {
  return (
    <div className="comment-zone-inner">
      {comments.map((c, i) => (
        <div
          key={c.remoteId}
          className={`comment-zone-item${i > 0 ? ' comment-zone-item-divider' : ''}`}
        >
          <CommentNode
            comment={c}
            connectionId={connectionId}
            depth={0}
            attachmentBase={attachmentBase}
            prLocalId={prLocalId}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * 把 Bitbucket 评论 markdown 里 `attachment:HASH` 形态的 URL 改写为可点击的 Bitbucket 链接。
 * 返回 null = 不是附件 URL，调用方按原样处理。
 */
function resolveAttachmentUrl(href: string, base: string | null): string | null {
  if (!base || !href.startsWith('attachment:')) return null;
  const hash = href.slice('attachment:'.length).trim();
  if (!hash) return null;
  return `${base}/${encodeURIComponent(hash)}`;
}

/**
 * react-markdown components 覆盖：a/img 检测 attachment: 协议，改写到 Bitbucket URL。
 * 图片附件因为 Bitbucket 需要会话鉴权，渲染器 fetch 不到，统一退化为可点击链接
 * （📎 alt 文本），点击走 setWindowOpenHandler → shell.openExternal 在系统
 * 浏览器打开，用户的 Bitbucket 登录 session 能正常加载。
 */
function makeCommentMarkdownComponents(
  attachmentBase: string | null,
  prLocalId: string,
): Parameters<typeof ReactMarkdown>[0]['components'] {
  const BitbucketImage = makeBitbucketImageFor(prLocalId);
  return {
    a: ({ href, children, ...rest }) => {
      const resolved = href ? resolveAttachmentUrl(href, attachmentBase) : null;
      const finalHref = resolved ?? href;
      return (
        <a {...rest} href={finalHref} target="_blank" rel="noreferrer">
          {resolved ? '📎 ' : null}
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      if (typeof src !== 'string' || !src) return null;
      // 把 src 原样传 IPC — main 端 adapter 懂 Bitbucket `attachment:HASH` 协议 + 绝对/
      // 相对 URL，renderer 不需要前置 resolve。外部公网 URL 在 main 端会被认为
      // 跨 host 返回 null，BitbucketImage 内部 fallback 到原生 <img>
      return <BitbucketImage src={src} alt={alt} />;
    },
  };
}

/**
 * 递归渲染单条评论 + 它的回复子树。Bitbucket 的 comment.comments[] 是任意层级的，
 * 之前只画了第一层 → 第三层及以上不显示；这里递归到底。每往下一层左移 18px
 * 并多一道左竖线（跟 Bitbucket 原生 UI 视觉对齐）。
 */
/** 嵌套缩进最大 5 层；第 6 层起 ml=0，跟第 5 层左对齐（避免过深一直右滑） */
const MAX_REPLY_INDENT_DEPTH = 5;

function CommentNode({
  comment,
  connectionId,
  depth,
  attachmentBase,
  prLocalId,
}: {
  comment: PrComment;
  connectionId: string;
  depth: number;
  attachmentBase: string | null;
  prLocalId: string;
}) {
  const components = useMemo(
    () => makeCommentMarkdownComponents(attachmentBase, prLocalId),
    [attachmentBase, prLocalId],
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // canDelete / canEdit main 端已经预判好 (annotateOwnership)
  const canDelete = comment.canDelete === true;
  const canEdit = comment.canEdit === true;

  const handleDelete = async (): Promise<void> => {
    if (!canDelete || comment.version === undefined) return;
    setConfirmDelete(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      await invoke('comments:delete', {
        localId: prLocalId,
        commentId: comment.remoteId,
        version: comment.version,
      });
      // 成功 → main 端清 cache + 广播 comments:changed → DiffView 重拉评论树 →
      // 顶层 useEffect 重建 zones → 本 zone 被销毁，没必要本地清状态
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };
  // body 只包 author + 正文 + 回复按钮 / 编辑器；replies 作为 sibling 放外面 —
  // 不让 hover 内层 replies 冒泡触发外层 :hover 导致所有祖先 reply 按钮一齐显示
  const inner = (
    <>
      <div className="comment-zone-item-body">
        <CommentAuthorRow
          displayName={comment.author.displayName}
          slug={comment.author.slug ?? comment.author.name}
          avatarUrl={comment.author.avatarUrl}
          connectionId={connectionId}
          at={comment.createdAt}
        />
        {editOpen && typeof comment.version === 'number' ? (
          <CommentEditEditor
            prLocalId={prLocalId}
            commentId={comment.remoteId}
            version={comment.version}
            initialBody={comment.body}
            onCancel={() => setEditOpen(false)}
            onSaved={() => setEditOpen(false)}
          />
        ) : (
          <div className="comment-zone-body markdown">
            {/* remarkBreaks：单换行即渲染成 <br>，与 Bitbucket/GitHub 评论上下文一致
                （评论场景按 hard-break，单 \n 就换行），也跟草稿预览/评论列表保持统一 */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              rehypePlugins={REMOTE_REHYPE_PLUGINS}
              components={components}
              urlTransform={transformBitbucketUrl}
            >
              {comment.body}
            </ReactMarkdown>
          </div>
        )}
        {/* 回复 / 编辑 / 删除按钮：默认 hidden，hover comment-zone-item-body 显示 (CSS)。
            编辑态隐藏全部按钮 (避免跟编辑器底部按钮组重复) */}
        {!replyOpen && !editOpen && (
          <div className="comment-zone-foot">
            <button
              type="button"
              className="comment-zone-reply-btn"
              onClick={() => setReplyOpen(true)}
            >
              回复
            </button>
            {canEdit && (
              <button
                type="button"
                className="comment-zone-edit-btn"
                onClick={() => setEditOpen(true)}
                title="编辑自己发布的评论 (远端同步)"
              >
                编辑
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="comment-zone-delete-btn"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                title="删除自己发布的评论 (远端同步)"
              >
                {deleting ? '删除中…' : '删除'}
              </button>
            )}
          </div>
        )}
        {replyOpen && (
          <CommentReplyEditor
            prLocalId={prLocalId}
            parentCommentId={comment.remoteId}
            onCancel={() => setReplyOpen(false)}
            onPosted={() => setReplyOpen(false)}
          />
        )}
        {deleteError && (
          <div className="comment-zone-delete-error" role="alert">
            删除失败：{deleteError}
            <button
              type="button"
              className="comment-zone-delete-error-dismiss"
              onClick={() => setDeleteError(null)}
              aria-label="关闭错误"
              title="知道了"
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {comment.replies.map((r) => (
        <CommentNode
          key={r.remoteId}
          comment={r}
          connectionId={connectionId}
          depth={depth + 1}
          attachmentBase={attachmentBase}
          prLocalId={prLocalId}
        />
      ))}
      {confirmDelete && (
        <ConfirmModal
          title="删除评论"
          message="此操作会删除远端 Bitbucket 上的这条评论，且无法恢复。确定继续吗？"
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
  if (depth === 0) return inner;
  // 第 1~5 层每层缩进 18px (相对父)；第 6+ 层 ml=0 跟上一级平齐
  const ml = depth <= MAX_REPLY_INDENT_DEPTH ? 18 : 0;
  return (
    <div className="comment-zone-reply" style={{ marginLeft: ml }}>
      {inner}
    </div>
  );
}

function CommentAuthorRow({
  displayName,
  slug,
  avatarUrl,
  connectionId,
  at,
}: {
  displayName: string;
  slug: string;
  avatarUrl?: string;
  connectionId: string;
  at: string;
}) {
  return (
    <div className="comment-zone-head">
      <Avatar
        connectionId={connectionId}
        slug={slug}
        displayName={displayName}
        avatarUrl={avatarUrl}
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
  // sync 完成后 IPC handler 还在跑 git diff 算变更文件列表，显示对应阶段提示
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

/**
 * Bitbucket 风格 blame 列。独立于 Monaco DOM 之外，作为 diff-pane-wrapper 的左侧
 * flex 子项；内部用 absolute 子项画各 commit 区块，按 Monaco scrollTop 平移。
 *
 * 设计权衡：
 * - 不走 Monaco InjectedText (DiffEditor 里实测不渲染，详见 commit 提交记录)
 * - 不走 Monaco overlay widget (没有"绝对行号"定位选项，只能贴角)
 * - 独立 DOM 列：可控、稳定、跟 React 生命周期一致；唯一成本是要同步 scrollTop
 */
function BlameColumn({
  blame,
  layout,
  connectionId,
  diffEditor,
}: {
  blame: { lines: DiffBlameLine[]; changedLines: number[] };
  layout: BlameLayout;
  connectionId: string;
  diffEditor: MonacoEditor.IStandaloneDiffEditor;
}) {
  const blocks = useMemo(() => groupBlameByCommit(blame.lines), [blame.lines]);
  // 把 changedLines 合并成连续区段，渲染色带（减少 DOM 数量）
  const changedRanges = useMemo(
    () => mergeContiguousLines(blame.changedLines),
    [blame.changedLines],
  );
  const modifiedEditor = diffEditor.getModifiedEditor();
  // layout 只是触发器：scrollTop / viewportHeight 任一变就重渲，重渲时再走 Monaco
  // 实时坐标 API，避免行数学手算和 Monaco 实际渲染的偏差（padding / view zones /
  // hideUnchangedRegions 占位 / sticky scroll 全靠 Monaco 自己算）
  // 注意：layout 也被上面 style 的 --blame-lh 引用

  // 只渲染 Monaco 当前可见的行：hideUnchangedRegions 折叠掉的行返回的 range
  // 里不会出现，自然不画 blame；评论 view zone 撑出的额外高度也由 Monaco 的
  // getTopForLineNumber 反映
  const visibleRanges = modifiedEditor.getVisibleRanges();
  const scrollTop = modifiedEditor.getScrollTop();

  type BlameItem = {
    kind: 'blame';
    block: BlameBlock;
    top: number;
    height: number;
    segId: string;
  };
  type ChangeItem = {
    kind: 'change';
    top: number;
    height: number;
    segId: string;
  };
  type FoldItem = { kind: 'fold'; top: number; height: number; segId: string };
  type Item = BlameItem | ChangeItem | FoldItem;
  const items: Item[] = [];

  // 1) Blame 区块：跟 visible range 求交集
  for (const range of visibleRanges) {
    for (const block of blocks) {
      const from = Math.max(block.lineFrom, range.startLineNumber);
      const to = Math.min(block.lineTo, range.endLineNumber);
      if (from > to) continue;
      const yTop = modifiedEditor.getTopForLineNumber(from) - scrollTop;
      const yBottom = modifiedEditor.getTopForLineNumber(to + 1) - scrollTop;
      items.push({
        kind: 'blame',
        block,
        top: yTop,
        height: Math.max(1, yBottom - yTop),
        segId: `b-${block.commit}-${String(from)}-${String(to)}`,
      });
    }
  }

  // 2) PR 改动行色带：在可见 range 内的部分画绿色竖条占位（不带文字，跟 Monaco
  //    diff 的"added"装饰呼应）
  for (const range of visibleRanges) {
    for (const [from0, to0] of changedRanges) {
      const from = Math.max(from0, range.startLineNumber);
      const to = Math.min(to0, range.endLineNumber);
      if (from > to) continue;
      const yTop = modifiedEditor.getTopForLineNumber(from) - scrollTop;
      const yBottom = modifiedEditor.getTopForLineNumber(to + 1) - scrollTop;
      items.push({
        kind: 'change',
        top: yTop,
        height: Math.max(1, yBottom - yTop),
        segId: `c-${String(from)}-${String(to)}`,
      });
    }
  }

  // 3) 折叠占位行（"X hidden lines"）：相邻两个 visibleRange 之间一行的位置，
  //    用斜纹/灰底标识"无效行"——这一行不对应 head 文件里任何 line，blame
  //    自然没有。
  for (let i = 0; i < visibleRanges.length - 1; i++) {
    const cur = visibleRanges[i]!;
    const next = visibleRanges[i + 1]!;
    if (next.startLineNumber - cur.endLineNumber <= 1) continue;
    // 占位行在 cur 的最后一行底部与 next 第一行顶部之间
    const yTop = modifiedEditor.getTopForLineNumber(cur.endLineNumber + 1) - scrollTop;
    const yBottom = modifiedEditor.getTopForLineNumber(next.startLineNumber) - scrollTop;
    if (yBottom <= yTop) continue;
    items.push({
      kind: 'fold',
      top: yTop,
      height: yBottom - yTop,
      segId: `f-${String(cur.endLineNumber)}-${String(next.startLineNumber)}`,
    });
  }

  return (
    <aside
      className="blame-column"
      // --blame-lh = Monaco 的实际行高，让 blame-row 的 grid 行轨道 / line-height
      // 都用同一个值，垂直跟 Monaco 第一行代码同高、同 baseline
      style={
        {
          width: BLAME_COLUMN_WIDTH,
          '--blame-lh': `${String(layout.lineHeight)}px`,
        } as React.CSSProperties
      }
      aria-label="blame"
    >
      <div className="blame-column-inner">
        {items.map((it) => {
          if (it.kind === 'blame') {
            return (
              <BlameRow
                key={it.segId}
                block={it.block}
                top={it.top}
                height={it.height}
                connectionId={connectionId}
              />
            );
          }
          if (it.kind === 'change') {
            return (
              <div
                key={it.segId}
                className="blame-row-change"
                style={{ top: it.top, height: it.height }}
                title="此区段为本 PR 引入的改动"
                aria-hidden="true"
              />
            );
          }
          // fold placeholder
          return (
            <div
              key={it.segId}
              className="blame-row-fold"
              style={{ top: it.top, height: it.height }}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </aside>
  );
}

function BlameRow({
  block,
  top,
  height,
  connectionId,
}: {
  block: BlameBlock;
  top: number;
  height: number;
  connectionId: string;
}) {
  // 用 ISO 风格 YYYY-MM-DD：locale 无关、固定 10 字符，在 70px 列宽稳定显示。
  // toLocaleDateString 的中文输出 "2023年3月29日" 太宽会被截断。
  const dateStr = block.authorDate ? formatIsoDate(new Date(block.authorDate)) : '';
  const title = `${block.author}\n${block.commit.slice(0, 12)}\n${block.summary}\n${
    block.authorDate ? new Date(block.authorDate).toLocaleString() : ''
  }`;
  return (
    <div className="blame-row" style={{ top, height }} title={title}>
      <Avatar
        connectionId={connectionId}
        slug={block.author}
        displayName={block.author}
        size={18}
      />
      <span className="blame-row-name" title={block.author}>
        {block.author}
      </span>
      <span className="blame-row-sha">{block.commit.slice(0, 11)}</span>
      <span className="blame-row-date">{dateStr}</span>
    </div>
  );
}

/** 整块替代 diff 区的硬错误展示（如变更文件列表本身拉不下来） */
function BackendErrorView({
  err,
  scope,
  onRetry,
}: {
  err: FormattedError;
  scope: string;
  onRetry?: () => void;
}) {
  return (
    <div className="diff-empty diff-error backend-error-view">
      <p className="backend-error-title">
        <strong>{scope}：</strong>
        {err.title}
      </p>
      <pre className="backend-error-detail">{err.detail}</pre>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/** 顶部细 banner，部分功能拉不下来但 diff 主体仍可用时显示 */
function BackendErrorBanner({
  err,
  scope,
  onRetry,
  onDismiss,
}: {
  err: FormattedError;
  scope: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className={`backend-error-banner backend-error-banner-${err.kind}`} role="alert">
      <span className="backend-error-banner-icon" aria-hidden="true">
        ⚠
      </span>
      <span className="backend-error-banner-text">
        <strong>{scope}：</strong>
        <span className="muted">{err.title}</span>
        <span className="backend-error-banner-detail" title={err.detail}>
          {summarizeDetail(err.detail)}
        </span>
      </span>
      <span className="backend-error-banner-actions">
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            重试
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="btn btn-sm backend-error-banner-dismiss"
            onClick={onDismiss}
            title="收起此通知"
            aria-label="dismiss"
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}

function summarizeDetail(detail: string): string {
  const firstLine = detail.split('\n')[0] ?? '';
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

function fileKey(f: DiffChangedFile): string {
  return `${f.oldPath ?? ''}|${f.path}`;
}


function DiffPane({
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
  if (loading || !content) {
    return (
      <div className="diff-empty">
        <span className="muted">
          <Spinner /> 拉取 <code>{file.path}</code> 内容…
          <br />
          <small>从本地镜像读 git blob，大文件 / 二进制判定时可能略慢</small>
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
      className={
        [
          showBlame ? 'diff-editor-with-blame' : '',
          showWhitespace ? 'diff-editor-show-eol' : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      options={{
        readOnly: true,
        renderSideBySide,
        minimap: { enabled: false },
        fontSize: editorFontSize(14),
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
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

export function languageFor(filePath: string): string {
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

