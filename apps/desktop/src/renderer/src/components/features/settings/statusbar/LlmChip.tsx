import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCodexCliModel, isCodexCliProfile, type Config } from '@meebox/shared';
import { ChevronIcon, StarIcon, StatusChip } from '../../../common';
import { Spinner } from '../../chat/components/shared';
import { useCodexModelCatalog } from '../../chat/hooks/useCodexModelCatalog';

/**
 * Summary of the currently active LLM profile. Click to expand a dropdown listing all profiles for direct switching.
 * When unconfigured, shows "LLM: not configured"; clicking opens settings directly.
 */
export function LlmChip({
  llm,
  onSwitch,
  onOpenSettings,
}: {
  llm: Config['llm'];
  onSwitch: (id: string, codexModel?: string | null) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  const submenuTrigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const { models, loading } = useCodexModelCatalog(open && llm.profiles.some(isCodexCliProfile));
  const codexProfile = llm.profiles.find(
    (profile) => profile.id === submenuId && isCodexCliProfile(profile),
  );
  const configuredModel = getCodexCliModel(codexProfile?.cli_args);
  useEffect(() => {
    if (submenuId) submenu.current?.querySelector('button')?.focus();
  }, [submenuId]);
  // Click outside to close the menu
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.llm-chip-menu') || target?.closest('.statusbar-llm-chip')) return;
      setOpen(false);
      setSubmenuId(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = llm.profiles.find((p) => p.id === llm.active_id);
  const empty = !active;
  const activeModel =
    active && isCodexCliProfile(active) ? getCodexCliModel(active.cli_args) : active?.model;
  const text = empty
    ? t('statusBar.llmNotConfigured')
    : activeModel || active.model || active.label || active.provider;
  const title = empty
    ? t('statusBar.llmNotConfiguredTitle')
    : `LLM: ${active.label || t('statusBar.unnamed')}\nprovider: ${active.provider}${
        activeModel ? `\nmodel: ${activeModel}` : ''
      }${active.base_url ? `\nbase_url: ${active.base_url}` : ''}`;

  const onClick = (): void => {
    if (empty || llm.profiles.length === 0) {
      onOpenSettings();
      return;
    }
    setOpen((v) => !v);
    setSubmenuId(null);
  };

  return (
    <span className="llm-chip-wrap">
      <StatusChip
        className={`llm-chip${empty ? '' : ' llm-chip-active'}`}
        title={title}
        onClick={onClick}
      >
        <StarIcon />
        {text}
      </StatusChip>
      {open && (
        <div
          className="llm-chip-menu"
          role="menu"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' && !(submenuId && event.key === 'ArrowLeft')) return;
            event.preventDefault();
            event.stopPropagation();
            if (submenuId) {
              setSubmenuId(null);
              submenuTrigger.current?.focus();
            } else {
              setOpen(false);
            }
          }}
        >
          {llm.profiles.map((p) => {
            const isActive = p.id === llm.active_id;
            const codex = isCodexCliProfile(p);
            const selected = codex ? getCodexCliModel(p.cli_args) : undefined;
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className={`llm-chip-menu-item${isActive ? ' active' : ''}`}
                aria-haspopup={codex ? 'menu' : undefined}
                aria-expanded={codex ? submenuId === p.id : undefined}
                onClick={(event) => {
                  if (codex) {
                    submenuTrigger.current = event.currentTarget;
                    setSubmenuId(submenuId === p.id ? null : p.id);
                    return;
                  }
                  onSwitch(p.id);
                  setOpen(false);
                  setSubmenuId(null);
                }}
                onKeyDown={(event) => {
                  if (!codex || event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  submenuTrigger.current = event.currentTarget;
                  setSubmenuId(p.id);
                }}
              >
                <span className="llm-chip-menu-tick" aria-hidden="true">
                  {isActive ? '✓' : ''}
                </span>
                <span className="llm-chip-menu-meta">
                  <span className="llm-chip-menu-title">
                    {p.label || t('statusBar.profileFallbackName', { id: p.id.slice(0, 4) })}
                  </span>
                  <span className="muted llm-chip-menu-sub">
                    {p.provider}
                    {p.model ? ` · ${p.model}` : ''}
                    {selected ? ` · ${selected}` : ''}
                  </span>
                </span>
                {codex && <ChevronIcon />}
              </button>
            );
          })}
          {codexProfile && (
            <div
              className="llm-chip-menu llm-chip-submenu"
              ref={submenu}
              role="menu"
              aria-label={t('statusBar.codexModels')}
            >
              {[
                { id: null, label: t('statusBar.codexDefaultModel') },
                ...(configuredModel && !models.some(({ id }) => id === configuredModel)
                  ? [{ id: configuredModel, label: configuredModel }]
                  : []),
                ...models,
              ].map((option) => {
                const checked = option.id === (configuredModel ?? null);
                return (
                  <button
                    key={option.id ?? ''}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    className={`llm-chip-menu-item${checked ? ' active' : ''}`}
                    onClick={() => {
                      onSwitch(codexProfile.id, option.id);
                      setOpen(false);
                      setSubmenuId(null);
                    }}
                  >
                    <span className="llm-chip-menu-tick" aria-hidden="true">
                      {checked ? '✓' : ''}
                    </span>
                    <span className="llm-chip-menu-title">{option.label}</span>
                  </button>
                );
              })}
              {loading && !models.length && (
                <div className="llm-chip-menu-item" role="status" aria-label={t('common.loading')}>
                  <Spinner />
                </div>
              )}
            </div>
          )}
          <div className="llm-chip-menu-divider" />
          <button
            type="button"
            className="llm-chip-menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <span className="llm-chip-menu-tick" aria-hidden="true" />
            <span className="muted">{t('statusBar.manageLlm')}</span>
          </button>
        </div>
      )}
    </span>
  );
}
