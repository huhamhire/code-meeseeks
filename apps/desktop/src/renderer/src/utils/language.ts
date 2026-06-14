/**
 * 按文件扩展名映射到 Monaco language id。Monaco 自带的 language 列表参见
 * https://github.com/microsoft/monaco-editor/tree/main/src/basic-languages
 *
 * 未识别 → 返回 'plaintext'。无扩展名文件按 basename 识别（Dockerfile / Makefile）。
 */
export function languageFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    xml: 'xml',
    php: 'php',
    rb: 'ruby',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    dockerfile: 'dockerfile',
  };
  if (!ext || ext === filePath.toLowerCase()) {
    const base = filePath.split('/').pop()?.toLowerCase() ?? '';
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
  }
  return map[ext] ?? 'plaintext';
}
