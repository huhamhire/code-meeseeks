import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('prPilot', {
  version: '0.0.0-m0b',
});
