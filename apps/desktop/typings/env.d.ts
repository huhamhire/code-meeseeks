/**
 * Renderer 端的 ambient 全局类型声明。放在 typings/ 而非 src/，避免跟业务源码混在
 * 同一目录。tsconfig.json 的 include 已经加上 `typings/**`。
 *
 * vite/client 的全局类型通过 tsconfig.json 的 compilerOptions.types 引入；
 * 不再 /// reference，跟 logger 包共享 typings 的做法保持一致。
 */
import type { IpcBridge } from '@pr-pilot/shared';

declare global {
  interface Window {
    api: IpcBridge;
  }
}
