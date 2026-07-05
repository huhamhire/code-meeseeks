import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import brandIcon from '@assets/icons/icon.png';
import { CommandPalette } from '../features/command-palette';
import type { SettingsCategory } from '../features/settings';
import type { FilterKey } from './Sidebar';

interface TitleBarProps {
  /** Running platform: macOS needs left-side space reserved for the traffic-light buttons; Windows/Linux window controls are drawn top-right by the system overlay. */
  platform: Platform;
  /** Context text shown in the title area (e.g. the current PR title); non-essential, yields to the command palette on narrow screens, can be omitted/hidden. */
  title?: string;
  /** Command palette context: current config + selected PR + synced parent state + open settings panel. */
  config: Config;
  selectedPrId: string | null;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  toggleChatPanel: () => void;
  togglePrList: () => void;
  discoveryFilters: readonly PrDiscoveryFilter[];
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  viewArchived: () => void;
  openPrByUrl: (url: string) => void | Promise<void>;
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  setPrStatusFilter: (filter: FilterKey) => void;
}

/**
 * Self-drawn title bar for the frameless window (VS Code style). The whole bar is `-webkit-app-region: drag`
 * so the window can be dragged; interactive elements within it must each be marked `no-drag` (see styles/titlebar.scss).
 *
 * Platform differences:
 * - macOS: `titleBarStyle: hidden` keeps the traffic-light buttons, leaving 72px on the left to avoid overlapping the brand name;
 *   the top-left space is occupied by the traffic lights, so the app icon is **not shown**, only the brand name.
 * - Windows/Linux: `titleBarOverlay` lets the system draw minimize/maximize/close top-right, so the right side is left blank;
 *   do not place clickable elements top-right (they would be covered by the overlay); the left side is free, showing the app icon at the start.
 */
export function TitleBar({
  platform,
  title,
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
}: TitleBarProps) {
  const isMac = platform === 'darwin';
  return (
    <header className={`app-titlebar${isMac ? ' app-titlebar--mac' : ''}`}>
      {!isMac && <img className="app-titlebar-icon" src={brandIcon} alt="" />}
      <div className="app-titlebar-brand">Code Meeseeks</div>
      {/* PR title stays in its original left position (avoiding the top-right Windows window controls); on narrow screens its right edge fades out and is covered by the centered command-palette overlay. */}
      {title && <div className="app-titlebar-title">{title}</div>}
      {/* Command palette: centered absolute overlay (placed later in DOM → drawn above the title, the input's opaque background covers the title beneath it). */}
      <div className="app-titlebar-center">
        <CommandPalette
          platform={platform}
          config={config}
          selectedPrId={selectedPrId}
          patchConfig={patchConfig}
          openSettings={openSettings}
          toggleChatPanel={toggleChatPanel}
          togglePrList={togglePrList}
          discoveryFilters={discoveryFilters}
          setDiscoveryFilter={setDiscoveryFilter}
          viewArchived={viewArchived}
          openPrByUrl={openPrByUrl}
          prStatusFilters={prStatusFilters}
          setPrStatusFilter={setPrStatusFilter}
        />
      </div>
    </header>
  );
}
