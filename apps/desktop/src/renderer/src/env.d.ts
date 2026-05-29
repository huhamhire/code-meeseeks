/// <reference types="vite/client" />

import type { IpcBridge } from '@pr-pilot/shared';

declare global {
  interface Window {
    api: IpcBridge;
  }
}
