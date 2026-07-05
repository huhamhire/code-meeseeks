import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Workspace internal packages are .ts source that Node cannot import directly; let Vite bundle them into main/preload,
// while external third-party deps (electron / pino / yaml / zod ...) stay externalized for Node to resolve at runtime.
const internalPackages = [
  '@meebox/shared',
  '@meebox/ipc',
  '@meebox/agent',
  '@meebox/config',
  '@meebox/logger',
  '@meebox/pr-agent-bridge',
  '@meebox/state-store',
  '@meebox/platform-core',
  '@meebox/platform-bitbucket-server',
  '@meebox/platform-github',
  '@meebox/platform-gitlab',
  '@meebox/poller',
  '@meebox/repo-mirror',
  '@meebox/rules',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    // Renderer references the repo root assets/ (single source for brand icons etc., avoiding duplicate binary copies)
    resolve: {
      alias: { '@assets': resolve('../../assets') },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
