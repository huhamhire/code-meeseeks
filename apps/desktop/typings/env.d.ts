/**
 * Ambient global type declarations for the renderer. Placed in typings/ rather than src/ to avoid
 * mixing with business source in the same directory. tsconfig.json's include already adds `typings/**`.
 *
 * vite/client's global types are brought in via tsconfig.json's compilerOptions.types;
 * no more /// reference, consistent with how the logger package shares typings.
 */
import type { IpcBridge } from '@meebox/ipc';

declare global {
  interface Window {
    api: IpcBridge;
  }
}
