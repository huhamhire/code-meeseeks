import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizePath } from 'vite';

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

const monacoStandaloneEditor =
  /^(.*\/monaco-editor)\/esm\/vs\/editor\/standalone\/browser\/standaloneCodeEditor\.js$/;

// Temporary workaround for microsoft/monaco-editor#5518. Global renderers must outlive each diff editor's child service.
function patchMonacoStandaloneEditor(source: string, id: string): string | undefined {
  const match = monacoStandaloneEditor.exec(normalizePath(id.split('?', 1)[0]));
  if (!match) return;

  const { version } = JSON.parse(readFileSync(resolve(match[1], 'package.json'), 'utf8'));
  const servicesImport = 'import { StandaloneKeybindingService, updateConfigurationService }';
  const hoverFactory = 'instantiationService.createInstance(WorkbenchHoverDelegate';
  const markdownFactory = 'instantiationService.createInstance(EditorMarkdownCodeBlockRenderer';
  if (
    version !== '0.56.0' ||
    ![servicesImport, hoverFactory, markdownFactory].every((target) => source.includes(target))
  ) {
    throw new Error(
      `Review the Monaco lifecycle workaround for monaco-editor ${version} (microsoft/monaco-editor#5518).`,
    );
  }

  const createInstance = 'StandaloneServices.get(IInstantiationService).createInstance';
  return source
    .replace(
      servicesImport,
      'import { StandaloneServices, StandaloneKeybindingService, updateConfigurationService }',
    )
    .replace(hoverFactory, `${createInstance}(WorkbenchHoverDelegate`)
    .replace(markdownFactory, `${createInstance}(EditorMarkdownCodeBlockRenderer`);
}

const monacoLifecycle = {
  name: 'monaco-standalone-lifecycle',
  enforce: 'pre' as const,
  transform: patchMonacoStandaloneEditor,
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
    build: {
      rolldownOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
    build: {
      rolldownOptions: {
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
    plugins: [react(), monacoLifecycle],
    optimizeDeps: {
      rolldownOptions: { plugins: [monacoLifecycle] },
    },
    build: {
      rolldownOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
