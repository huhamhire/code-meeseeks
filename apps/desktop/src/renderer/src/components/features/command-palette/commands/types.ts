import type { TFunction } from 'i18next';
import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import type { SettingsCategory } from '../../settings';
import type { FilterKey } from '../../../layout/Sidebar';

/**
 * The command palette's execution context: current config + hooks to sync parent state + open settings panel + current-language t.
 * The command's "instant effect" reuses the same primitives as the settings page (i18n.changeLanguage / editor-appearance store / config:* IPC),
 * without spinning up a separate set, ensuring behavior consistent with the settings page. Every domain's command builder receives it.
 */
export interface CommandContext {
  /** Running platform: used by commands to format shortcut hints (mac ⌘ / others Ctrl), etc. */
  platform: Platform;
  config: Config;
  /** localId of the currently selected PR (null if none selected); context-relevant commands (such as running auto review) use it to trim / pick the target. */
  selectedPrId: string | null;
  /** Whether a PR has an orchestration Agent running (for re-entry protection; reads the live state at call time). */
  isPrRunning: (localId: string) => boolean;
  /** Toggle chat panel collapse (used by the command palette's "toggle chat panel"). */
  toggleChatPanel: () => void;
  /** Toggle PR list (sidebar) collapse (used by the command palette's "toggle PR list"). */
  togglePrList: () => void;
  /** PR discovery categories supported by the current platform's capabilities (empty = the platform has no categories, the corresponding top-level command is not provided). */
  discoveryFilters: readonly PrDiscoveryFilter[];
  /** Jump to a discovery category (used by PR-domain "view X" commands, such as "awaiting my review"); implicitly switches back to the "in progress" scope. */
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  /** Switch to the "closed" (archived) scope (used by the PR-domain "view closed" command). */
  viewArchived: () => void;
  /** Open a PR of the current platform by URL (used by the PR-domain "open URL" free-text command): locate locally or fetch the archive then jump, popping a toast on failure. */
  openPrByUrl: (url: string) => void | Promise<void>;
  /** Optional PR status filter items (pending / all / conflict / mergeable, etc., already gated by platform). */
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  /** Set the PR status filter (used by the PR-domain "category filter" second-level options). */
  setPrStatusFilter: (filter: FilterKey) => void;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  /** Translation function for the current UI language */
  t: TFunction;
  /** Fixed English (en-US) translation function: shown as a secondary line under a non-English UI, and always participates in search (aligning with VS Code) */
  tEn: TFunction;
}

/** Second-level option (leaf, executes directly). `active` marks the currently effective item (checked). */
export interface CommandOption {
  id: string;
  title: string;
  /** English name (default = title, i.e. a proper name / data item consistent across languages); shown as a secondary line under a non-English UI + always participates in search */
  titleEn?: string;
  active?: boolean;
  run: () => void;
}

/**
 * Top-level command: either executes directly (`run`), or enters second-level options (`options`). **At most two levels**, going back up is not supported
 * (exit with Esc then re-enter, see docs/arch/03-gui/02-command-palette). `title` / `category` are already localized to the current UI language, for searching in the current language.
 */
export interface RootCommand {
  id: string;
  /** Context gating (optional): returning false hides this command from the list. Default = always visible. Filtered uniformly by the registry; each domain only needs to declare it. */
  when?: () => boolean;
  title: string;
  /** English title: shown as a secondary line under a non-English UI, and always participates in search (aligning with VS Code display language + English search) */
  titleEn: string;
  category: string;
  /** English domain prefix: same as titleEn, used for secondary-line display and English search */
  categoryEn: string;
  /** Shortcut key token list (one box per key, e.g. `['⌘','B']` / `['Ctrl','B']`), shown on the right side of the command item; default = none */
  shortcut?: string[];
  /** Input placeholder hint after entering the second level */
  optionsPlaceholder?: string;
  /** Short prefix indicator to the left of the input after entering the second level (e.g. "URL"); default falls back to the command title. */
  prefixLabel?: string;
  /** Second-level options (lazily evaluated, reads current config to mark active); one of run / input / this three */
  options?: () => CommandOption[];
  /**
   * Free-text input (second level): once selected, the second level is not an option list but turns the input box into one that accepts arbitrary text, submitting to `run` on Enter.
   * Used for commands like "open PR by URL" that require the user to paste / type. Mutually exclusive with options / top-level run.
   */
  input?: { placeholder: string; run: (text: string) => void | Promise<void> };
  /** Execution of a leaf command; one of options / input two */
  run?: () => void;
}
