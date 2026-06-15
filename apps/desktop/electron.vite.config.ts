import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Workspace 内部包源码是 .ts，Node 无法直接 import；让 Vite 把它们 bundle 进主进程/preload，
// 外部第三方依赖（electron / pino / yaml / zod ...）继续 externalize 让 Node 在运行时解析。
const internalPackages = [
  '@meebox/shared',
  '@meebox/agent',
  '@meebox/config',
  '@meebox/logger',
  '@meebox/pr-agent-bridge',
  '@meebox/state-store',
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
    // 渲染层引用仓库根 assets/（品牌图标等单一来源，避免拷贝重复二进制）
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
