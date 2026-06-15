/**
 * Vite `?raw` 资源导入：把文件正文作为字符串内联（electron-vite 主进程 / vitest / 内部包通用）。
 * 渲染层另由 `vite/client` 提供同名声明；此处覆盖主进程与内部包
 * （如 @meebox/agent 的模版加载）的 typecheck 范围。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
