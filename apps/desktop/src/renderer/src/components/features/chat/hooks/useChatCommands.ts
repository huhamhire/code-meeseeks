import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { CommandSpec } from '../commands';

export function useChatCommands({
  input,
  onInputChange,
  textareaRef,
  commands,
  disabled,
}: {
  input: string;
  onInputChange: (input: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  commands: readonly CommandSpec[];
  disabled: boolean;
}) {
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false);
  // Selected-item index of the autocomplete menu (the overlay shown when the textarea contains /)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  // Menu was already dismissed for a specific input value (Esc / inserted after selecting). Invalidated as soon as input changes
  // → the menu naturally reappears as the user keeps typing, but does not immediately re-pop right after selecting / Esc
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);

  const showAutocomplete =
    !disabled && dismissedFor !== input && input.startsWith('/') && !/\s/.test(input);
  const filtered = showAutocomplete ? commands.filter((c) => c.label.startsWith(input)) : [];

  // Reset the selected item to the first when input changes (the candidate set changed)
  useEffect(() => {
    setAutocompleteIdx(0);
  }, [input]);

  // Popup menu triggered by the `/` command button: closes on outside click / Esc / selecting a command
  useEffect(() => {
    if (!cmdMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!cmdMenuRef.current?.contains(e.target as Node)) {
        setCmdMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCmdMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [cmdMenuOpen]);

  const handleInsertCommand = (cmd: CommandSpec): void => {
    onInputChange(cmd.insertAs);
    setCmdMenuOpen(false);
    // Close the autocomplete menu immediately after selecting (insertAs may be "/describe" with no space, otherwise it would keep it propped open).
    // dismissedFor is bound to the current input value; as the user keeps typing and input changes, the menu reopens
    setDismissedFor(cmd.insertAs);
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(cmd.insertAs.length, cmd.insertAs.length);
      });
    }
  };

  const handleCommandKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || !filtered.length) return false;
    // When the autocomplete menu is open: intercept Up/Down/Enter/Tab/Esc for menu navigation, to avoid falling through to the textarea
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setAutocompleteIdx((i) => (i + delta + filtered.length) % filtered.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const cmd = filtered[Math.min(autocompleteIdx, filtered.length - 1)];
      if (cmd) handleInsertCommand(cmd);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedFor(input);
      return true;
    }

    return false;
  };

  return {
    disabled,
    commands,
    filtered,
    autocompleteIdx,
    setAutocompleteIdx,
    cmdMenuOpen,
    setCmdMenuOpen,
    cmdMenuRef,
    handleInsertCommand,
    handleCommandKeyDown,
  };
}
