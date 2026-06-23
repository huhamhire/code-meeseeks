import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { StarIcon, StatusChip } from '../../../common';

/**
 * 当前 active LLM profile 概要。点击展开下拉，列出所有 profile 直接切换。
 * 未配置时显示 "LLM: 未配置"，点击直接打开设置。
 */
export function LlmChip({
  llm,
  onSwitch,
  onOpenSettings,
}: {
  llm: Config['llm'];
  onSwitch: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 点外面关菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.llm-chip-menu') || target?.closest('.statusbar-llm-chip')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = llm.profiles.find((p) => p.id === llm.active_id);
  const empty = !active;
  const text = empty
    ? t('statusBar.llmNotConfigured')
    : active.model || active.label || active.provider;
  const title = empty
    ? t('statusBar.llmNotConfiguredTitle')
    : `LLM: ${active.label || t('statusBar.unnamed')}\nprovider: ${active.provider}${
        active.model ? `\nmodel: ${active.model}` : ''
      }${active.base_url ? `\nbase_url: ${active.base_url}` : ''}`;

  const onClick = (): void => {
    if (empty || llm.profiles.length === 0) {
      onOpenSettings();
      return;
    }
    setOpen((v) => !v);
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
        <div className="llm-chip-menu" role="menu">
          {llm.profiles.map((p) => {
            const isActive = p.id === llm.active_id;
            return (
              <button
                key={p.id}
                type="button"
                className={`llm-chip-menu-item${isActive ? ' active' : ''}`}
                onClick={() => {
                  onSwitch(p.id);
                  setOpen(false);
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
                  </span>
                </span>
              </button>
            );
          })}
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
