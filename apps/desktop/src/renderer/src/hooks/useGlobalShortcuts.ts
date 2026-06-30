import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { invoke } from '../api';
import { chatRunStore } from '../stores/chat-run-store';

/**
 * 窗口级全局快捷键（VS Code 风），统一在此挂一个 `keydown` 监听：
 * - **F5**：对当前选中 PR 运行自动评审（与命令面板同逻辑：有选中 PR、可参与、且未在跑才触发——重入保护）。
 * - **DevTools**：mac ⌥⌘I / 其余 Ctrl+Shift+I（带 Shift/Alt，与下面单修饰键的 B/J 区分）。
 * - **查看已关闭**：mac ⌘⇧H（避开系统「隐藏应用」⌘H）/ 其余 Ctrl+H（浏览器历史惯例）。
 * - **布局开关**：Ctrl/Cmd+B 切 PR 列表（左侧栏）、Ctrl/Cmd+J 切对话面板（右侧）；单修饰键，排除 Shift/Alt
 *   （避开 Cmd+Shift+P 命令面板）。
 *
 * `selectedId` / `canEngage` 经 ref 读实时值，使监听只随 platform 与几个稳定回调重建、不随选中 PR 频繁重订阅。
 */
export function useGlobalShortcuts({
  platform,
  selectedId,
  canEngage,
  viewArchived,
  setSidebarCollapsed,
  setChatCollapsed,
}: {
  platform: string | undefined;
  selectedId: string | null;
  canEngage: boolean;
  viewArchived: () => void;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setChatCollapsed: Dispatch<SetStateAction<boolean>>;
}): void {
  // 选中 PR / 可参与态的 ref：供稳定监听读实时值，免得每次切 PR 重订阅。
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const canEngageRef = useRef(canEngage);
  canEngageRef.current = canEngage;

  useEffect(() => {
    const isMac = platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // F5：对当前选中 PR 运行自动评审（有选中 PR、可参与、且未在跑才触发——重入保护）
      if (k === 'f5') {
        const id = selectedIdRef.current;
        if (id && canEngageRef.current && !chatRunStore.getSnapshot().agentPrs.includes(id)) {
          e.preventDefault();
          void invoke('agent:run', { localId: id });
        }
        return;
      }
      // DevTools：mac ⌥⌘I / 其余 Ctrl+Shift+I（带 Shift/Alt，与下面单修饰键的 B/J 区分）
      if (k === 'i') {
        const devtools = isMac
          ? e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey
          : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
        if (devtools) {
          e.preventDefault();
          void invoke('app:openDevTools', undefined);
        }
        return;
      }
      // 查看已关闭（history）：mac ⌘⇧H（避开系统「隐藏应用」⌘H）/ 其余 Ctrl+H（浏览器历史惯例）
      if (k === 'h') {
        const wantArchived = isMac
          ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
        if (wantArchived) {
          e.preventDefault();
          viewArchived();
        }
        return;
      }
      // 单修饰键布局开关：Ctrl/Cmd+B（PR 列表）、Ctrl/Cmd+J（对话面板）
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (k === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (k === 'j') {
        e.preventDefault();
        setChatCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, viewArchived, setSidebarCollapsed, setChatCollapsed]);
}
