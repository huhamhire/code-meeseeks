import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import { buildRootCommands, type RootCommand } from './commands';
import { readMru, pushMru } from './mru';
import { chatRunStore } from '../../../stores/chat-run-store';
import type { FilterKey } from '../../layout/Sidebar';
import type { SettingsCategory } from '../settings';

interface CommandPaletteProps {
  /** 运行平台：决定打开快捷键修饰键（mac = Cmd+Shift+P，其余 = Ctrl+Shift+P）。 */
  platform: Platform;
  config: Config;
  /** 当前选中 PR 的 localId（上下文相关命令用，如运行自动评审）。 */
  selectedPrId: string | null;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  /** 切换对话面板折叠（评审域命令用）。 */
  toggleChatPanel: () => void;
  /** 切换 PR 列表（侧栏）折叠（PR 域命令用）。 */
  togglePrList: () => void;
  /** 当前平台支持的发现分类（PR 域「一级分类」命令门控用）。 */
  discoveryFilters: readonly PrDiscoveryFilter[];
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  /** 切到「已关闭」（归档）范围（PR 域「查看已关闭」命令用）。 */
  viewArchived: () => void;
  /** 可选的 PR 状态筛选项（PR 域「分类筛选」二级选项用）。 */
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  setPrStatusFilter: (filter: FilterKey) => void;
}

/** 当前层（顶层 / 二级）展开后用于渲染的扁平项。 */
interface FlatItem {
  id: string;
  title: string;
  /** 英文标题（缺省=title）：非英语界面作次行展示，并恒参与检索 */
  titleEn: string;
  category?: string;
  categoryEn?: string;
  active?: boolean;
  /** 快捷键按键 token（一键一框，如 ['⌘','B']），右侧展示 */
  shortcut?: string[];
  onSelect: () => void;
}

/**
 * 把文本里匹配查询的（连续）子串包成高亮 `<mark>`，与列表的 `includes` 子串过滤一致。
 * 空查询原样返回；大小写不敏感；同一文本里多处命中都高亮。
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
 * 标题栏命令面板（VS Code 风）：标题栏内嵌输入框 + 下拉结果。快捷键 mac Cmd+Shift+P /
 * 其余 Ctrl+Shift+P 打开聚焦。**最多两级**——顶层命令选中后若有二级选项则原地替换为选项列表，
 * 不支持返回上级（Esc 退出后重进）。搜索按当前界面语言匹配命令文案。设计见 docs/arch/13。
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
  prStatusFilters,
  setPrStatusFilter,
}: CommandPaletteProps) {
  const { t, i18n } = useTranslation();
  // 重入保护：调用时取实时运行中 PR 集合（编排 Agent），稳定引用避免命令清单频繁重建
  const isPrRunning = useCallback(
    (id: string) => chatRunStore.getSnapshot().agentPrs.includes(id),
    [],
  );
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<RootCommand | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 固定英文翻译器（en-US 静态打包、恒可用）：非英语界面作次行 + 恒按英文检索
  const tEn = useMemo(() => i18n.getFixedT('en-US'), [i18n]);
  const isEnglish = i18n.language === 'en-US';

  const roots = useMemo(
    () => {
      // 显式引用 i18n.language：t 引用在切语言后不变，需以语言为 key 重建命令文案（搜索按当前语言匹配）
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

  // 经 ref 取最新 roots，让 mruActiveIndex / openPalette 保持稳定引用（供快捷键 effect 依赖、不反复重订阅）
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  // 打开（空查询、顶层）时默认选中「最近用过且当前仍存在」的命令，回车即重复上次；查无回落第一条。
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

  const items: FlatItem[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    // haystack 恒含英文（本地化 + 英文一起匹配）：非英语界面下也始终支持英文检索
    const has = (hay: string): boolean => !q || hay.toLowerCase().includes(q);
    if (level) {
      return level
        .options!()
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
          pushMru(r.id); // 记最近使用（顶层命令；进容器 / 叶子执行都记）
          if (r.options) {
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
      // 顶层按「领域前缀 + 命令名」（中英一起）匹配：搜领域名（如「设置」/「Settings」）可归类筛出该域全部命令
      .filter((it) => has(`${it.category} ${it.title} ${it.categoryEn} ${it.titleEn}`));
  }, [level, query, roots]);

  // 列表变化后把高亮项夹在范围内
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, items.length - 1)));
  }, [items.length]);

  // 全局快捷键：mac Cmd+Shift+P / 其余 Ctrl+Shift+P 打开
  useEffect(() => {
    const isMac = platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, openPalette]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[activeIndex]?.onSelect();
    }
  };

  return (
    <div className="cmdk">
      <input
        ref={inputRef}
        className="cmdk-input"
        type="text"
        spellCheck={false}
        placeholder={level ? level.optionsPlaceholder : t('commandPalette.placeholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          // 点击聚焦打开（空查询、顶层）时同样预选最近用过的命令
          if (query === '' && level === null) setActiveIndex(mruActiveIndex());
          setOpen(true);
        }}
        onBlur={() => {
          // 延迟关闭：让下拉项的 click 先于 blur 生效（项的 onMouseDown 已 preventDefault 保住焦点）
          blurTimer.current = setTimeout(close, 120);
        }}
        onKeyDown={onInputKeyDown}
        aria-label={t('commandPalette.placeholder')}
      />
      {open && (
        <div className="cmdk-panel" role="listbox">
          {items.length === 0 ? (
            <div className="cmdk-empty">{t('commandPalette.empty')}</div>
          ) : (
            items.map((it, i) => {
              // 非英语界面且英文与本地化不同 → 次行显示英文（对齐 VS Code 显示语言）
              const showEn =
                !isEnglish &&
                (it.titleEn !== it.title || (it.categoryEn ?? '') !== (it.category ?? ''));
              return (
                <button
                  key={it.id}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`cmdk-item${i === activeIndex ? ' is-active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
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
