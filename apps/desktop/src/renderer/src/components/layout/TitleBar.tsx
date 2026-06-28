import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import brandIcon from '@assets/icons/icon.png';
import { CommandPalette } from '../features/command-palette';
import type { SettingsCategory } from '../features/settings';
import type { FilterKey } from './Sidebar';

interface TitleBarProps {
  /** 运行平台：macOS 需为红绿灯留出左侧占位；Windows/Linux 窗控由系统 overlay 画在右上。 */
  platform: Platform;
  /** 标题区展示的上下文文案（如当前 PR 标题）；非必要、窄屏让位给命令面板，可省略隐藏。 */
  title?: string;
  /** 命令面板上下文：当前配置 + 选中 PR + 同步父级状态 + 打开设置面板。 */
  config: Config;
  selectedPrId: string | null;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  toggleChatPanel: () => void;
  togglePrList: () => void;
  discoveryFilters: readonly PrDiscoveryFilter[];
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  setPrStatusFilter: (filter: FilterKey) => void;
}

/**
 * 无边框窗口的自绘标题栏（VS Code 风）。整条 `-webkit-app-region: drag` 可拖拽窗口，
 * 其中的交互元素需各自标 `no-drag`（见 styles/titlebar.scss）。
 *
 * 平台差异：
 * - macOS：`titleBarStyle: hidden` 保留红绿灯，左侧留 72px 占位避免与品牌名重叠；
 *   左上空间被红绿灯占据，**不展示**应用图标，仅品牌名。
 * - Windows/Linux：`titleBarOverlay` 让系统在右上画最小化/最大化/关闭，故右侧留白，
 *   勿在右上角放可点元素（会被 overlay 覆盖）；左侧空闲，开头展示应用图标。
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
  prStatusFilters,
  setPrStatusFilter,
}: TitleBarProps) {
  const isMac = platform === 'darwin';
  return (
    <header className={`app-titlebar${isMac ? ' app-titlebar--mac' : ''}`}>
      {!isMac && <img className="app-titlebar-icon" src={brandIcon} alt="" />}
      <div className="app-titlebar-brand">Code Meeseeks</div>
      {/* PR 标题留在左侧原位（避开右上 Windows 窗控）；窄屏时右缘渐隐、被居中的命令面板浮层遮盖。 */}
      {title && <div className="app-titlebar-title">{title}</div>}
      {/* 命令面板：居中绝对浮层（DOM 置后→绘制在标题之上，输入框不透明底覆盖其下标题）。 */}
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
          prStatusFilters={prStatusFilters}
          setPrStatusFilter={setPrStatusFilter}
        />
      </div>
    </header>
  );
}
