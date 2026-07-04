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
 * Cross-file search state machine: query / case sensitivity (localStorage-persisted) / results / loading / error /
 * file collapse state + debounced search + async colorize + content cache (cleared on PR switch). Auto-focuses the input on mount.
 * Pure algorithm see ./diff-search; colorize see ./colorize.
 */
export function useDiffSearch(files: DiffChangedFile[], prLocalId: string) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // Case sensitivity persisted across sessions — once the user's habit settles (usually off or on), having to
  // toggle it again every time they open the search panel is annoying. Write to localStorage once and remember it
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
      // Silently ignore failures like private mode / quota full, doesn't affect search functionality
    }
  }, [caseSensitive]);
  const [results, setResults] = useState<FileResults[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Expanded by default — the user already actively searched, no need for another click to see results
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());

  // Token for the current search session, letting old async tasks discover they've been cancelled
  const sessionRef = useRef(0);
  // Content cache: when searching different keywords in the same PR, don't re-fetch what invoke diff:getFileContent already got
  // key: `${side}:${path}` → text content
  const contentCacheRef = useRef<Map<string, string | null>>(new Map());
  // Clear the cache on PR switch
  useEffect(() => {
    contentCacheRef.current = new Map();
  }, [prLocalId]);

  // Auto-focus the input on mount, saving a click
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
          // First show plain-text results with <mark> keyword highlight — the user sees matches immediately
          setResults(r);
          setError(partialError);
          // Async colorize: Monaco colorize runs serially per file language; token is tied to the session,
          // a stale session no longer updates state
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
