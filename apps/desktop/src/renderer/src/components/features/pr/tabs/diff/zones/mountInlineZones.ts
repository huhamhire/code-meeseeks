import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import { remapOldByLineToModified } from './line-mapping';

/**
 * 通用 Monaco 行内 view-zone 挂载机制：行内评论 zone 与草稿 zone 共用同一套管线——
 * 双层 `dom`/`inner` 结构、`stopPropagation` 事件接管、宽度 `applyInnerLayout`、横向滚动
 * `translateX` 同步、高度 `ResizeObserver` 回写、按视图把 old 侧映射到对应编辑器、`removeZone` /
 * `unmount` 清理。差异点（拦截哪些事件、初始高度估算、渲染什么组件）由 options 注入。
 *
 * 返回 cleanup 函数（在 effect 的 teardown 调）。评论 zone 额外的 glyph decorations 不在此处
 * 管理（由调用方 useCommentZones 自行 create / clear）。
 */
export interface MountInlineZonesOptions<T> {
  diffEditor: MonacoEditor.IStandaloneDiffEditor;
  renderSideBySide: boolean;
  /** old 侧（删除 / base 侧上下文行）分桶：key = 行号 */
  oldByLine: Map<number, T[]>;
  /** new 侧（新增 / head 侧上下文行）分桶：key = 行号 */
  newByLine: Map<number, T[]>;
  /** monaco wrapper dom 的 class（'monaco-comment-zone' / 'monaco-draft-zone'） */
  zoneClassName: string;
  /** 真实视觉容器 inner 的 class（'monaco-comment-zone-inner' / 'monaco-draft-zone-inner'） */
  innerClassName: string;
  /** dom + inner 上 stopPropagation 接管的事件集合（草稿含 keydown/wheel 等，评论仅鼠标点击类） */
  stopEvents: readonly string[];
  /** 初始 zone 高度（px）估算；lineHeight 为 monaco 当前行高 */
  initialHeight: (items: T[], lineHeight: number) => number;
  /** 渲染 zone 内容（React 节点） */
  render: (items: T[]) => ReactNode;
}

interface ZoneRef {
  editor: MonacoEditor.ICodeEditor;
  zoneId: string;
  root: Root;
  disposers: Array<() => void>;
}

export function mountInlineZones<T>(opts: MountInlineZonesOptions<T>): () => void {
  const {
    diffEditor,
    renderSideBySide,
    oldByLine,
    newByLine,
    zoneClassName,
    innerClassName,
    stopEvents,
    initialHeight,
    render,
  } = opts;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const zoneRefs: ZoneRef[] = [];

  const addZonesFor = (editorInst: MonacoEditor.ICodeEditor, byLine: Map<number, T[]>): void => {
    const lineHeight = editorInst.getOption(MonacoEditorNs.EditorOption.lineHeight);
    editorInst.changeViewZones((accessor) => {
      for (const [line, items] of byLine) {
        // 双层结构：dom 是 monaco wrapper（monaco 直接把 height inline 写到它上面），
        // inner 是不受 monaco 控制的真实视觉容器 → inner.offsetHeight 才是真实内容高度。
        const dom = document.createElement('div');
        dom.className = zoneClassName;

        // 经典 Monaco view zone 坑：editor 自带 mousedown listener 把整个 zone 区域当作
        // "editor mouse target" 吞掉冒泡到 DOM 的事件 → zone 内 textarea 收不到 focus、button
        // 点不响应。在 dom 容器上 stopPropagation 一组关键事件，让 monaco 不再接管 zone 内的
        // user input。**必须是 bubble 阶段**（第三参数省略 / false）：capture 阶段拦截会在事件
        // 到达 button/textarea 之前就阻断，React onClick / onKeyDown 根本不触发。bubble 阶段让
        // target 上的 React handler 先 fire，再阻止冒泡到 editor。
        const stopAll = (e: Event): void => e.stopPropagation();
        for (const evt of stopEvents) {
          dom.addEventListener(evt, stopAll);
        }

        const inner = document.createElement('div');
        inner.className = innerClassName;
        dom.appendChild(inner);

        const root = createRoot(inner);
        root.render(render(items));

        const initialPx = initialHeight(items, lineHeight);
        const zoneObj: MonacoEditor.IViewZone = {
          afterLineNumber: line,
          heightInPx: initialPx,
          domNode: dom,
        };
        const zoneId = accessor.addZone(zoneObj);

        // 高度同步：直接 mutate zoneObj.heightInPx + layoutZone(id)。removeZone+addZone 在 textarea
        // 拖拽 resize 时每帧调用会引起 zone 重建抖动。layoutZone 是轻量操作，先 mutate
        // heightInPx 再 layoutZone 即可让 monaco 重新计算 viewModel whitespace。
        // 用 inner.offsetHeight 测（dom 被 monaco 写死 height，offsetHeight 会自循环）。
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
        // ResizeObserver 跟踪 inner 高度变化（read↔edit 切换、textarea resize、内嵌图片异步加载、
        // 嵌套评论展开）。requestAnimationFrame 避开"回调里同步 layout 又触发 RO"循环。
        const ro = new ResizeObserver(() => {
          requestAnimationFrame(syncHeight);
        });
        ro.observe(inner);
        // 多个时间点 sync 兜底覆盖布局抖动 / React 多阶段 render
        requestAnimationFrame(syncHeight);
        setTimeout(syncHeight, 50);
        setTimeout(syncHeight, 200);

        // 宽度 + 位置策略（跟 Bitbucket / GitHub inline 评论对齐）：用 BoundingClientRect 拿浏览器
        // 实际渲染坐标（clientWidth / layoutInfo.width 在 monaco inline 视图下偶发超出 editor 视觉
        // 边界，实测评论框跨到 ChatPane 区域）。inner 从 dom 起点开始，最远延伸到 editor 视觉右边界
        // - verticalScrollbar。dom 还没挂到 DOM 树时 rect.width=0，用 editor 左边界兜底。
        const editorDomNode = editorInst.getDomNode();
        const applyInnerLayout = (): void => {
          if (!editorDomNode) return;
          const editorRect = editorDomNode.getBoundingClientRect();
          if (editorRect.width <= 0) return; // editor 还没 layout，等下次 trigger
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
        // 多个时间点兜底：切换文件 + autoEdit 跳转时 monaco 在算 diff / 文件 mount 还没完，
        // getBoundingClientRect 给的不是稳定 layout（实测跳转新文件框宽度撑爆，resize 后恢复）。
        requestAnimationFrame(applyInnerLayout);
        setTimeout(applyInnerLayout, 50);
        setTimeout(applyInnerLayout, 200);
        setTimeout(applyInnerLayout, 500);
        // 双触发：onDidLayoutChange（几何变化）+ ResizeObserver 观察 editor DOM（窗口 / 分隔条
        // resize），覆盖不重叠；onDidUpdateDiff（切文件后算 diff 时 layout 仍在变，算完才稳定）。
        const layoutDisp = editorInst.onDidLayoutChange(applyInnerLayout);
        const diffDisp = diffEditor.onDidUpdateDiff(() => requestAnimationFrame(applyInnerLayout));
        const editorRO = editorDomNode
          ? new ResizeObserver(() => requestAnimationFrame(applyInnerLayout))
          : null;
        if (editorDomNode && editorRO) editorRO.observe(editorDomNode);

        // 横向滚动同步：monaco view zone dom 在 .lines-content 内会跟 scrollLeft 一起左移
        // （横滚后框被裁出 viewport）。给 inner 加 transform translateX(scrollLeft) 反向抵消，
        // 框就 stick 在 viewport 内的相对位置不动（跟 Bitbucket / GitHub inline 评论一致）。
        const applyScroll = (): void => {
          inner.style.transform = `translateX(${editorInst.getScrollLeft()}px)`;
        };
        applyScroll();
        const scrollDisp = editorInst.onDidScrollChange(applyScroll);

        // inner 上也 stopPropagation 一份（双层防御）。**必须晚于 createRoot** —— 否则 React 18 在
        // inner 上的 event delegation 初始化顺序受影响，导致 onClick 不 fire（取消按钮点了没反应）。
        for (const evt of stopEvents) {
          inner.addEventListener(evt, stopAll);
        }

        zoneRefs.push({
          editor: editorInst,
          zoneId,
          root,
          // 先 disconnect ResizeObserver + dispose listener，再 unmount root，避免 unmount
          // 引起的 DOM 高度回落触发观察回调 + layoutZone(disposed editor) 报错。
          disposers: [
            () => ro.disconnect(),
            () => layoutDisp.dispose(),
            () => diffDisp.dispose(),
            () => editorRO?.disconnect(),
            () => scrollDisp.dispose(),
          ],
        });
      }
    });
  };

  // 并排视图：old 侧挂原始编辑器；统一视图：原始编辑器隐藏，old 侧改挂 modified 编辑器对应行
  // （删除行在统一视图是 modified 的 view zone，按 diff 行变更把原始行号映射到 modified afterLineNumber）。
  if (renderSideBySide) {
    addZonesFor(originalEditor, oldByLine);
  } else if (oldByLine.size > 0) {
    addZonesFor(
      modifiedEditor,
      remapOldByLineToModified(diffEditor.getLineChanges() ?? [], oldByLine),
    );
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
    for (const z of zoneRefs) {
      for (const dispose of z.disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
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
}
