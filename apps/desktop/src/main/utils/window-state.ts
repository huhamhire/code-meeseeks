import fs from 'node:fs';
import path from 'node:path';
import type { StateStore } from '@meebox/state-store';

/**
 * 主窗口的本地状态（持久化在 state store），让下次启动沿用上次的窗口大小。
 * 只存尺寸 + 最大化态，不存 x/y 位置 —— 多显示器/分辨率变化时按坐标恢复易把窗口摆到屏幕外，
 * 尺寸恢复无此风险，也契合「记住窗口大小」的诉求（建窗时按当前显示器工作区居中，见 window-manager）。
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

/** 写回窗口状态（in-session 防抖回写走 store，并发安全 + 原子）。 */
export async function writeWindowState(store: StateStore, state: WindowState): Promise<void> {
  await store.write<WindowState>(KEY, state);
}

/**
 * 关窗同步落盘：`close` 事件后进程即退出（Windows/Linux 关最后一个窗口即 quit），异步写来不及 flush
 * → 尺寸丢失。故关窗走同步写兜底。路径与 JsonFileStateStore 的 key→path 映射一致（`<stateDir>/window/state.json`）。
 */
export function writeWindowStateSync(stateDir: string, state: WindowState): void {
  const file = path.join(stateDir, `${KEY}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
