import { useTranslation } from 'react-i18next';
import type { useChatCommands } from '../hooks/useChatCommands';

type Props = { menu: ReturnType<typeof useChatCommands> };

export function ChatCommandSuggestions({ menu }: Props) {
  const { t } = useTranslation();
  const { filtered, autocompleteIdx, setAutocompleteIdx, handleInsertCommand } = menu;
  if (!filtered.length) return null;
  return (
    <ul className="chat-cmd-suggest" role="listbox" aria-label={t('chatPane.cmdSuggestAria')}>
      {filtered.map((c, i) => {
        const active = i === Math.min(autocompleteIdx, filtered.length - 1);
        const prev = filtered[i - 1];
        const needDivider = prev !== undefined && prev.kind !== c.kind;
        return (
          <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
            <button
              type="button"
              className={`chat-cmd-suggest-item${active ? ' active' : ''}`}
              onClick={() => handleInsertCommand(c)}
              onMouseEnter={() => setAutocompleteIdx(i)}
              onMouseDown={(e) => {
                // Prevent the blur handler from collapsing the menu after the textarea loses focus
                e.preventDefault();
              }}
              role="option"
              aria-selected={active}
            >
              <code>{c.label}</code>
              <span className="muted">{t(c.descKey)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ChatCommandButton({ menu }: Props) {
  const { t } = useTranslation();
  const {
    disabled,
    commands: visibleCommands,
    cmdMenuOpen,
    setCmdMenuOpen,
    cmdMenuRef,
    handleInsertCommand,
  } = menu;
  return (
    <div className="chat-cmd-bar" ref={cmdMenuRef}>
      <button
        type="button"
        className={`chat-cmd-trigger${cmdMenuOpen ? ' active' : ''}`}
        onClick={() => setCmdMenuOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={cmdMenuOpen}
        title={t('chatPane.cmdTriggerTitle')}
      >
        /
      </button>
      {cmdMenuOpen && (
        <ul className="chat-cmd-menu" role="menu">
          {visibleCommands.map((c, i) => {
            const prev = visibleCommands[i - 1];
            // Insert a divider at the pragent → review-action boundary
            const needDivider = prev !== undefined && prev.kind !== c.kind;
            return (
              <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
                <button
                  type="button"
                  className="chat-cmd-suggest-item"
                  onClick={() => handleInsertCommand(c)}
                  role="menuitem"
                >
                  <code>{c.label}</code>
                  <span className="muted">{t(c.descKey)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
