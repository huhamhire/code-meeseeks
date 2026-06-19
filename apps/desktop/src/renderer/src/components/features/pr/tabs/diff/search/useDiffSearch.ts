import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffChangedFile } from '@meebox/ipc';
import { colorizeAll } from './colorize';
import {
  CASE_SENSITIVE_LS_KEY,
  SEARCH_DEBOUNCE_MS,
  runSearch,
  type FileResults,
} from './diff-search';

/**
 * 跨文件搜索状态机：query / 大小写敏感(localStorage 持久化) / 结果 / loading / error /
 * 文件折叠态 + 去抖搜索 + 异步着色 + 内容缓存（PR 切换清）。mount 自动聚焦输入框。
 * 纯算法见 ./diff-search；着色见 ./colorize。
 */
export function useDiffSearch(files: DiffChangedFile[], prLocalId: string) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // 大小写敏感跨 session 持久化 — 用户习惯一旦定下来 (一般是关或开)，每次
  // 进搜索面板都得重新切一次很烦。localStorage 写一次就记住
  const [caseSensitive, setCaseSensitive] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CASE_SENSITIVE_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CASE_SENSITIVE_LS_KEY, caseSensitive ? '1' : '0');
    } catch {
      // 隐私模式 / 配额满 等失败静默，不影响搜索功能
    }
  }, [caseSensitive]);
  const [results, setResults] = useState<FileResults[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 默认全部展开 — 用户已经主动搜索，不需要再点一次才看结果
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());

  // 当前 search session 的 token，让旧的异步任务发现自己被取消
  const sessionRef = useRef(0);
  // 内容缓存：同一个 PR 搜不同关键字时 invoke diff:getFileContent 拿过的不重复拉
  // key: `${side}:${path}` → text content
  const contentCacheRef = useRef<Map<string, string | null>>(new Map());
  // PR 切换时清缓存
  useEffect(() => {
    contentCacheRef.current = new Map();
  }, [prLocalId]);

  // mount 时自动聚焦输入框，省一次点击
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    const token = ++sessionRef.current;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void runSearch(token, q, caseSensitive, files, prLocalId, contentCacheRef.current, t)
        .then(({ results: r, partialError }) => {
          if (token !== sessionRef.current) return;
          // 先显示带 <mark> 关键词高亮的纯文本结果 — 用户立刻能看到命中
          setResults(r);
          setError(partialError);
          // 异步着色：Monaco colorize 按文件 language 串行执行；token 跟 session
          // 关联，过期 session 不再 update state
          void colorizeAll(r, token, sessionRef).then((colorized) => {
            if (token === sessionRef.current) setResults(colorized);
          });
        })
        .catch((e: unknown) => {
          if (token !== sessionRef.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setResults([]);
        })
        .finally(() => {
          if (token === sessionRef.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, caseSensitive, files, prLocalId, t]);

  const totalMatches = useMemo(
    () => results.reduce((n, fr) => n + fr.matches.length, 0),
    [results],
  );

  const toggleFile = (path: string): void => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    results,
    loading,
    error,
    collapsedFiles,
    toggleFile,
    totalMatches,
    inputRef,
  };
}
