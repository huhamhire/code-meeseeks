/**
 * Vite `?raw` asset import: inlines the file body as a string (shared across electron-vite main process / vitest / internal packages).
 * The renderer gets the same-named declaration from `vite/client`; this covers the typecheck scope
 * of the main process and internal packages (e.g. @meebox/agent's template loading).
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
