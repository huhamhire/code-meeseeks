import Editor from '@monaco-editor/react';

const welcome = `# pr-pilot

M0-B 脚手架就绪。

## 当前能跑

- Electron 主进程 + preload + renderer
- React 19 + Vite HMR
- TypeScript strict
- Monaco editor (你正在看的这个)

## 下一步

- **M0-C**: tRPC IPC、contextIsolation/CSP、pino 日志、~/.pr-pilot/ 首启引导
- **M0-D**: pr-agent 可用性探测 + GitHub Actions CI
- **M1**: Bitbucket Server PR 轮询
`;

export default function App() {
  const version = window.prPilot?.version ?? 'unknown';

  return (
    <div className="app">
      <header className="app-header">
        <h1>pr-pilot</h1>
        <span className="badge">M0-B</span>
        <span className="version">v{version}</span>
      </header>
      <main className="app-main">
        <Editor
          height="100%"
          defaultLanguage="markdown"
          defaultValue={welcome}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 14,
            wordWrap: 'on',
            padding: { top: 16 },
          }}
          theme="vs-dark"
        />
      </main>
    </div>
  );
}
