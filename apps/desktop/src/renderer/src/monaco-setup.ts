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
