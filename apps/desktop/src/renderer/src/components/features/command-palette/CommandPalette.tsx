import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import { buildRootCommands, type RootCommand } from './commands';
import { readMru, pushMru } from './mru';
import { chatRunStore } from '../../../stores/chat-run-store';
import type { FilterKey } from '../../layout/Sidebar';
import type { SettingsCategory } from '../settings';

interface CommandPaletteProps {
  /** Running platform: decides the open shortcut modifier (mac = Cmd+Shift+P, others = Ctrl+Shift+P). */
  platform: Platform;
  config: Config;
  /** localId of the currently selected PR (for context-relevant commands, e.g. run auto review). */
  selectedPrId: string | null;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  /** Toggle the chat panel collapse (used by review-domain command). */
  toggleChatPanel: () => void;
  /** Toggle the PR list (sidebar) collapse (used by PR-domain command). */
  togglePrList: () => void;
  /** Discovery filters supported by the current platform (gates the PR-domain "top-level filter" commands). */
  discoveryFilters: readonly PrDiscoveryFilter[];
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  /** Switch to the "closed" (archived) scope (used by the PR-domain "view closed" command). */
  viewArchived: () => void;
  /** Open a PR of the current platform by URL (used by the PR-domain "open URL" free-text command). */
  openPrByUrl: (url: string) => void | Promise<void>;
  /** Selectable PR status filters (used by the PR-domain "filter by category" second-level options). */
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  setPrStatusFilter: (filter: FilterKey) => void;
}

/** Flat item used for rendering after the current level (top / second) is expanded. */
interface FlatItem {
  id: string;
  title: string;
  /** English title (defaults to title): shown as a secondary line in non-English UI, and always searchable */
  titleEn: string;
  category?: string;
  categoryEn?: string;
  active?: boolean;
  /** Shortcut key tokens (one key per box, e.g. ['⌘','B']), shown on the right */
  shortcut?: string[];
  onSelect: () => void;
}

/**
 * Wraps the (contiguous) substring of the text matching the query in a highlight `<mark>`, matching the list's `includes` substring filter.
 * Empty query returns as-is; case-insensitive; all hits within the same text are highlighted.
 */
function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let hit = lower.indexOf(ql);
  let key = 0;
  while (hit !== -1) {
    if (hit > from) parts.push(text.slice(from, hit));
    parts.push(
      <mark key={key++} className="cmdk-hl">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    from = hit + q.length;
    hit = lower.indexOf(ql, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Title-bar command palette (VS Code style): input box embedded in the title bar + dropdown results. Shortcut mac Cmd+Shift+P /
 * others Ctrl+Shift+P to open and focus. **At most two levels** — after a top-level command is selected, if it has second-level options they replace the list in place,
 * with no going back up (Esc to exit then re-enter). Search matches command text by the current UI language. Design: docs/arch/03-gui/02-command-palette.
 */
export function CommandPalette({
  platform,
  config,
  selectedPrId,
  patchConfig,
  openSettings,
  toggleChatPanel,
  togglePrList,
  discoveryFilters,
  setDiscoveryFilter,
  viewArchived,
  openPrByUrl,
  prStatusFilters,
  setPrStatusFilter,
}: CommandPaletteProps) {
  const { t, i18n } = useTranslation();
  // Reentrancy guard: read the live set of running PRs (orchestration Agent) on call; stable reference avoids frequent command-list rebuilds
  const isPrRunning = useCallback(
    (id: string) => chatRunStore.getSnapshot().agentPrs.includes(id),
    [],
  );
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<RootCommand | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  // Last pointer coordinates: used to distinguish "real mouse movement" from "panel appearing under a stationary cursor / synthetic hover from scrolling".
  const pointerRef = useRef({ x: -1, y: -1 });
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Fixed English translator (en-US statically bundled, always available): secondary line in non-English UI + always searchable in English
  const tEn = useMemo(() => i18n.getFixedT('en-US'), [i18n]);
  const isEnglish = i18n.language === 'en-US';

  const roots = useMemo(
    () => {
      // Explicitly reference i18n.language: the t reference stays unchanged after a language switch, so command text must be rebuilt keyed by language (search matches the current language)
      void i18n.language;
      return buildRootCommands({
        platform,
        config,
        selectedPrId,
        isPrRunning,
        toggleChatPanel,
        togglePrList,
        discoveryFilters,
        setDiscoveryFilter,
        viewArchived,
        openPrByUrl,
        prStatusFilters,
        setPrStatusFilter,
        patchConfig,
        openSettings,
        t,
        tEn,
      });
    },
    [
      platform,
      config,
      selectedPrId,
      isPrRunning,
      toggleChatPanel,
      togglePrList,
      discoveryFilters,
      setDiscoveryFilter,
      viewArchived,
      openPrByUrl,
      prStatusFilters,
      setPrStatusFilter,
      patchConfig,
      openSettings,
      t,
      tEn,
      i18n.language,
    ],
  );

  const close = (): void => {
    setOpen(false);
    setLevel(null);
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.blur();
  };

  // Get the latest roots via ref so mruActiveIndex / openPalette keep stable references (for the shortcut effect's deps, avoiding repeated re-subscription)
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  // On open (empty query, top level) default-select the "most recently used and still present" command, so Enter repeats last; fall back to the first if none found.
  const mruActiveIndex = useCallback((): number => {
    for (const id of readMru()) {
      const i = rootsRef.current.findIndex((r) => r.id === id);
      if (i !== -1) return i;
    }
    return 0;
  }, []);

  const openPalette = useCallback((): void => {
    setLevel(null);
    setQuery('');
    setActiveIndex(mruActiveIndex());
    setOpen(true);
    inputRef.current?.focus();
  }, [mruActiveIndex]);

  // Open directly into a "free-text input" command's input level (for the "open URL" shortcut to jump straight in, skipping open-palette-then-select).
  const openInputCommand = useCallback((id: string): void => {
    const cmd = rootsRef.current.find((r) => r.id === id);
    if (!cmd?.input) return;
    setLevel(cmd);
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
    inputRef.current?.focus();
  }, []);

  const items: FlatItem[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    // haystack always includes English (localized + English matched together): English search stays available even in non-English UI
    const has = (hay: string): boolean => !q || hay.toLowerCase().includes(q);
    if (level) {
      // Free-text input mode (e.g. "open URL"): second level has no options list; input box accepts arbitrary text, submitted on Enter.
      if (!level.options) return [];
      return level
        .options()
        .map((o) => ({
          id: o.id,
          title: o.title,
          titleEn: o.titleEn ?? o.title,
          active: o.active,
          onSelect: () => {
            o.run();
            close();
          },
        }))
        .filter((it) => has(`${it.title} ${it.titleEn}`));
    }
    return roots
      .map((r) => ({
        id: r.id,
        title: r.title,
        titleEn: r.titleEn,
        category: r.category,
        categoryEn: r.categoryEn,
        shortcut: r.shortcut,
        onSelect: () => {
          pushMru(r.id); // record MRU (top-level command; recorded whether entering a container or executing a leaf)
          if (r.options || r.input) {
            // Container (second-level options) or free-text input: enter the second level in place
            setLevel(r);
            setQuery('');
            setActiveIndex(0);
            inputRef.current?.focus();
          } else {
            r.run?.();
            close();
          }
        },
      }))
      // Top level matches by "domain prefix + command name" (Chinese and English together): searching a domain name (e.g. "设置" / "Settings") filters out all commands in that domain
      .filter((it) => has(`${it.category} ${it.title} ${it.categoryEn} ${it.titleEn}`));
  }, [level, query, roots]);

  // After the list changes, clamp the highlighted item within range
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, items.length - 1)));
  }, [items.length]);

  // Scroll the highlighted item into view: on open the default selection is the MRU item (may be mid-list) and needs auto-scroll; same for arrow-key navigation.
  useEffect(() => {
    if (open) activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, items.length]);

  // Global shortcut: mac Cmd+Shift+P / others Ctrl+Shift+P to open
  useEffect(() => {
    const isMac = platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'p') {
        e.preventDefault();
        openPalette();
      } else if (k === 'u') {
        // ⌘⇧U / Ctrl+Shift+U: jump straight to the "open URL" input level (U = URL)
        e.preventDefault();
        openInputCommand('open-pr-url');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, openPalette, openInputCommand]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // During IME composition (candidate not yet confirmed): this keypress (especially Enter) is only for confirming the candidate, not triggering command selection / navigation.
    // Otherwise, when typing Chinese etc., the Enter that confirms the candidate would also select the command and enter the second level, while compositionend's onChange writes the candidate
    // back into query → the second level gets filtered by leftover text (unexpected filtering). The user presses once more after confirming to act, consistent with common search boxes.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Backspace' && level && query === '') {
      // At the second level (prompt state) with an empty query, Backspace goes back up one level (top-level command list)
      e.preventDefault();
      setLevel(null);
      setQuery('');
      setActiveIndex(mruActiveIndex());
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Free-text input mode: Enter submits the current text to the command (only if non-empty).
      if (level?.input) {
        const text = query.trim();
        if (text) {
          void level.input.run(text);
          close();
        }
        return;
      }
      items[activeIndex]?.onSelect();
    }
  };

  return (
    <div className="cmdk">
      <div className="cmdk-field">
        {/* Second-level prefix prompt: after entering a sub-level, show a short prefix (prefixLabel, e.g. "URL") or fall back to the command name, to anchor context */}
        {level && <span className="cmdk-field-prefix">{level.prefixLabel ?? level.title}</span>}
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          spellCheck={false}
          placeholder={
            level
              ? (level.input?.placeholder ?? level.optionsPlaceholder)
              : t('commandPalette.placeholder')
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            // On click-focus open (empty query, top level), likewise pre-select the most recently used command
            if (query === '' && level === null) setActiveIndex(mruActiveIndex());
            setOpen(true);
          }}
          onBlur={() => {
            // Delayed close: let a dropdown item's click take effect before blur (the item's onMouseDown already preventDefault to keep focus)
            blurTimer.current = setTimeout(close, 120);
          }}
          onKeyDown={onInputKeyDown}
          aria-label={t('commandPalette.placeholder')}
        />
      </div>
      {/* Free-text input mode (e.g. "open URL") shows no dropdown — no options, pure input + Enter (the placeholder explains) */}
      {open && !level?.input && (
        <div className="cmdk-panel" role="listbox">
          {items.length === 0 ? (
            <div className="cmdk-empty">{t('commandPalette.empty')}</div>
          ) : (
            items.map((it, i) => {
              // Non-English UI and English differs from localized → show English on a secondary line (aligns with VS Code display language)
              const showEn =
                !isEnglish &&
                (it.titleEn !== it.title || (it.categoryEn ?? '') !== (it.category ?? ''));
              return (
                <button
                  key={it.id}
                  ref={i === activeIndex ? activeItemRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`cmdk-item${i === activeIndex ? ' is-active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  // Only real mouse movement changes the highlight: the panel popping up under a stationary cursor (mouseenter), or keyboard-navigation scrolling moving an item
                  // under the cursor (synthetic event, coordinates unchanged), must not steal the MRU default / keyboard selection. Only take over when coordinates truly change.
                  onMouseMove={(e) => {
                    if (e.clientX === pointerRef.current.x && e.clientY === pointerRef.current.y) {
                      return;
                    }
                    pointerRef.current = { x: e.clientX, y: e.clientY };
                    setActiveIndex(i);
                  }}
                  onClick={it.onSelect}
                >
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-line">
                      {it.category && (
                        <span className="cmdk-item-cat">{highlight(it.category, query)}</span>
                      )}
                      <span className="cmdk-item-title">{highlight(it.title, query)}</span>
                    </span>
                    {showEn && (
                      <span className="cmdk-item-line cmdk-item-sub">
                        {it.categoryEn && (
                          <span className="cmdk-item-cat">{highlight(it.categoryEn, query)}</span>
                        )}
                        <span className="cmdk-item-title">{highlight(it.titleEn, query)}</span>
                      </span>
                    )}
                  </span>
                  {it.shortcut && (
                    <span className="cmdk-item-kbd">
                      {it.shortcut.map((k, ki) => (
                        <kbd key={ki} className="cmdk-key">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  )}
                  {it.active && (
                    <span className="cmdk-item-check" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
