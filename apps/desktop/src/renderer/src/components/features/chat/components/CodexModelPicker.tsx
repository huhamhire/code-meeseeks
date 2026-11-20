import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon } from '../../../common';
import { Spinner } from './shared';

type ModelOption = { id: string; label: string };

export function CodexModelPicker({
  label,
  options,
  selected,
  loading,
  onSelect,
}: {
  label: string;
  options: readonly ModelOption[];
  selected?: ModelOption;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const selectedId = selected?.id;
  const [activeId, setActiveId] = useState(selectedId);
  const disabled = loading || options.length === 0;
  const open = position !== null && !disabled;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId),
  );
  const activeIndex = options.findIndex((option) => option.id === activeId);
  const index = activeIndex < 0 ? selectedIndex : activeIndex;

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!triggerRef.current?.contains(event.target) && !listRef.current?.contains(event.target)) {
        setPosition(null);
      }
    };
    const resize = () => {
      setPosition(null);
      if (document.activeElement === listRef.current) triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [open, index]);

  const show = (initial = selectedIndex) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    setActiveId(options[initial]?.id ?? selectedId);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 6,
      width,
      maxHeight: Math.max(0, Math.min(320, rect.top - 14)),
    });
  };

  const close = () => {
    setPosition(null);
    triggerRef.current?.focus();
  };

  const pick = (option: ModelOption) => {
    onSelect(option.id);
    close();
  };

  const handleKey = (event: KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveId(options[(index + delta + options.length) % options.length]?.id);
        break;
      }
      case 'Home':
        setActiveId(options[0]?.id);
        break;
      case 'End':
        setActiveId(options.at(-1)?.id);
        break;
      case 'Enter':
      case ' ':
        if (options[index]) pick(options[index]);
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="chat-codex-model-trigger"
        aria-label={!loading && selected ? `${label} · ${selected.label}` : label}
        aria-busy={loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={loading ? undefined : (selected?.label ?? label)}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          show();
        }}
      >
        {loading ? (
          <Spinner />
        ) : (
          <>
            <span>{selected?.label ?? label}</span>
            <ChevronIcon />
          </>
        )}
      </button>
      {open &&
        position &&
        createPortal(
          <ul
            id={id}
            ref={listRef}
            className="chat-codex-model-menu"
            style={position}
            tabIndex={-1}
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${id}-${String(index)}`}
            onKeyDown={handleKey}
            onBlur={(event) => {
              if (event.relatedTarget !== triggerRef.current) setPosition(null);
            }}
          >
            {options.map((option, i) => (
              <li
                id={`${id}-${String(i)}`}
                key={option.id}
                role="option"
                aria-selected={option.id === selectedId}
                className={index === i ? 'active' : undefined}
                onPointerMove={() => setActiveId(option.id)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                <span className="chat-codex-model-check" aria-hidden="true">
                  {option.id === selectedId ? '✓' : ''}
                </span>
                {option.label}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
