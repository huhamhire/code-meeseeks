// 让 @monaco-editor/react 使用本地 monaco-editor 包，而不是从 CDN 拉 loader.js。
// 配合 CSP 严格化（无 cdn.jsdelivr.net 例外）。
//
// 仅注册 base editor worker，markdown / 通用 diff 用不到 JSON/CSS/HTML/TS language worker。
// M1+ 真正要做语法高亮时再按需 import 对应 language worker。

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
// 4 个「带 worker 后端语言服务」的 contribution 子模块（editor.main 已加载，这里再引一次只为
// 取其具名导出的 *Defaults；ES module 单例不会重复执行）。它们的运行期 JS 具名导出
// typescriptDefaults / jsonDefaults / cssDefaults … 但 .d.ts 误为 `export {}`（monaco 0.55 ESM
// 打包缺陷），故按 namespace 引入、下方经 unknown 转成已知形状取用，不引入 any。
import * as tsLang from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import * as jsonLang from 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import * as cssLang from 'monaco-editor/esm/vs/language/css/monaco.contribution.js';
import * as htmlLang from 'monaco-editor/esm/vs/language/html/monaco.contribution.js';

// Vite 的 ?worker import 返回一个可 new 的 Worker 构造类。
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

/**
 * 关掉 4 个「带 worker 后端语言服务」的语言族的全部特性：typescript/javascript（ts.worker）、
 * json（json.worker）、css/scss/less（css.worker）、html/handlebars/razor（html.worker）。
 *
 * 本应用只用 Monaco 做只读 diff + 语法着色（着色走 monarch tokenizer，与语言服务无关），不需要
 * 补全 / 悬浮 / 符号 / 诊断 / 格式化等；而这些特性会向对应 *.worker 发 RPC（getNavigationTree /
 * getSyntacticDiagnostics / doValidation …）。但我们只注册了 base editor.worker（见上 getWorker）
 * → 这些方法找不到 handler，抛 `Missing requestHandler or method: …`。
 *
 * 传空 ModeConfiguration（各字段均 optional，缺省即不注册对应 provider）→ 这些 provider 不再注册、
 * 不再发 RPC，从源头消除整族报错（下方 window 兜底退化为纯保险）。其余 80+ 语言是 monarch
 * tokenizer 纯着色、无 worker 后端，不受影响也无需处理。
 */
interface LangServiceDefaults {
  // 传空 ModeConfiguration（各字段均 optional，缺省即不注册对应 provider）= 关掉全部特性
  setModeConfiguration(modeConfiguration: object): void;
}
// 运行期具名导出存在（见各 contribution.js 的 export），但其 .d.ts 误为 `export {}`，故经
// unknown 转成已知 *Defaults 形状取用（不引入 any）；名字缺失时 filter 兜底，未来 monaco 改名不崩。
const defaultsOf = (mod: unknown, names: readonly string[]): LangServiceDefaults[] =>
  names
    .map((n) => (mod as Record<string, LangServiceDefaults | undefined>)[n])
    .filter((d): d is LangServiceDefaults => typeof d?.setModeConfiguration === 'function');

for (const d of [
  ...defaultsOf(tsLang, ['typescriptDefaults', 'javascriptDefaults']),
  ...defaultsOf(jsonLang, ['jsonDefaults']),
  ...defaultsOf(cssLang, ['cssDefaults', 'scssDefaults', 'lessDefaults']),
  ...defaultsOf(htmlLang, ['htmlDefaults', 'handlebarDefaults', 'razorDefaults']),
]) {
  d.setModeConfiguration({});
}

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
const BENIGN_MONACO_ERROR_PREFIXES = ['Missing requestHandler or method:'];
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
