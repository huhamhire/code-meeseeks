import type { StateStore } from '@meebox/state-store';

/**
 * 主窗口的本地状态（持久化在 state store），让下次启动沿用上次的窗口大小。
 * 只存尺寸 + 最大化态，不存 x/y 位置 —— 多显示器/分辨率变化时按坐标恢复易把窗口摆到屏幕外，
 * 尺寸恢复无此风险，也契合「记住窗口大小」的诉求。
 */
export interface WindowState {
  width?: number;
  height?: number;
  /** 上次关闭时是否最大化；是则下次启动以正常尺寸建窗后再 maximize。 */
  maximized?: boolean;
}

const KEY = 'window/state';

/** 读取窗口状态；无文件 / 读取失败由调用方兜底为空。 */
export async function readWindowState(store: StateStore): Promise<WindowState> {
  return (await store.read<WindowState>(KEY)) ?? {};
}

/** 写回窗口状态。 */
export async function writeWindowState(store: StateStore, state: WindowState): Promise<void> {
  await store.write<WindowState>(KEY, state);
}
