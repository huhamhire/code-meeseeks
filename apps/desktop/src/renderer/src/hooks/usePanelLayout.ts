import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { CHAT_MAX_WIDTH, CHAT_MIN_WIDTH } from '../components/features/chat';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../components/layout/Sidebar';

function clampWidth(raw: string | null, min: number, max: number): number {
  const n = raw ? Number(raw) : 360;
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : 360));
}

/**
 * 左右两栏（PR 列表 / chat）的宽度与折叠态：初值从 localStorage 读（夹到各自 min/max），
 * 变化即回写。纯 UI 布局态，不涉及业务。
 */
export function usePanelLayout(): {
  sidebarWidth: number;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  chatWidth: number;
  setChatWidth: Dispatch<SetStateAction<number>>;
  chatCollapsed: boolean;
  setChatCollapsed: Dispatch<SetStateAction<boolean>>;
} {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    clampWidth(localStorage.getItem('meebox.sidebarWidth'), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('meebox.sidebarCollapsed') === '1',
  );
  const [chatWidth, setChatWidth] = useState<number>(() =>
    clampWidth(localStorage.getItem('meebox.chatWidth'), CHAT_MIN_WIDTH, CHAT_MAX_WIDTH),
  );
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(
    // 默认收起：chat 早期是空壳，避免空占地方
    () => (localStorage.getItem('meebox.chatCollapsed') ?? '1') === '1',
  );
  useEffect(() => {
    localStorage.setItem('meebox.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem('meebox.sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('meebox.chatWidth', String(chatWidth));
  }, [chatWidth]);
  useEffect(() => {
    localStorage.setItem('meebox.chatCollapsed', chatCollapsed ? '1' : '0');
  }, [chatCollapsed]);
  return {
    sidebarWidth,
    setSidebarWidth,
    sidebarCollapsed,
    setSidebarCollapsed,
    chatWidth,
    setChatWidth,
    chatCollapsed,
    setChatCollapsed,
  };
}
