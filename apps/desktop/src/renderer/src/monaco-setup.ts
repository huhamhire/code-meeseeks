// 让 @monaco-editor/react 使用本地 monaco-editor 包，而不是从 CDN 拉 loader.js。
// 配合 CSP 严格化（无 cdn.jsdelivr.net 例外）。
//
// 仅注册 base editor worker，markdown / 通用 diff 用不到 JSON/CSS/HTML/TS language worker。
// M1+ 真正要做语法高亮时再按需 import 对应 language worker。

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// Vite 的 ?worker import 返回一个可 new 的 Worker 构造类。
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

/**
 * Monaco 在 DiffEditor 快速切换文件时，会出现 model 已 dispose 但 widget 还在
 * 收尾的竞态；以及"内置 ts/js language contribution 主动询问 inlayHints /
 * quickInfo / navigationTree / ...，editor.worker 没实现对应方法"的一系列运行时
 * 报错。两类都不影响渲染，但污染 console 让用户以为应用挂了。
 *
 * 仅按消息前缀黑名单吞掉，不动其他真实业务错误，也不动 Monaco 各 language
 * 默认配置（保持 vendor 默认行为，未来换 monaco 版本时不用维护补丁）。
 *
 * `Missing requestHandler or method:` 整族都源于同一机制（Monaco 给 worker
 * 发 RPC 找不到 handler），用前缀一勺烩；不一一列出 getQuickInfoAtPosition /
 * getCompletionsAtPosition / provideInlayHints 这种 whack-a-mole 名单。
 */
const BENIGN_MONACO_ERROR_PREFIXES = [
  'Missing requestHandler or method:',
];
const BENIGN_MONACO_ERROR_SUBSTRINGS = [
  'TextModel got disposed before DiffEditorWidget model got reset',
];

function isBenignMonacoError(msg: unknown): boolean {
  if (typeof msg !== 'string') return false;
  if (BENIGN_MONACO_ERROR_PREFIXES.some((p) => msg.includes(p))) return true;
  if (BENIGN_MONACO_ERROR_SUBSTRINGS.some((s) => msg.includes(s))) return true;
  return false;
}

window.addEventListener('error', (e) => {
  if (isBenignMonacoError(e.message) || isBenignMonacoError(e.error?.message)) {
    e.preventDefault();
    // 留一行 console.warn 便于诊断，避免完全静默
    console.warn('[monaco] suppressed benign error:', e.message);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: unknown } | unknown;
  const msg = typeof reason === 'string' ? reason : (reason as { message?: unknown })?.message;
  if (isBenignMonacoError(msg)) {
    e.preventDefault();
    console.warn('[monaco] suppressed benign rejection:', msg);
  }
});
