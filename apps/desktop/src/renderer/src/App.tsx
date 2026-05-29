import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { AppInfo, AppPaths, Config } from '@pr-pilot/shared';
import { invoke } from './api';

interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        if (!window.api) {
          throw new Error(
            'preload bridge missing: window.api is undefined — preload script did not expose `api`',
          );
        }
        const [info, paths, config] = await Promise.all([
          invoke('app:info', undefined),
          invoke('app:paths', undefined),
          invoke('config:read', undefined),
        ]);
        setBootstrap({ info, paths, config });
      } catch (e) {
        const msg = e instanceof Error ? `${e.message}\n\nstack:\n${e.stack ?? '(none)'}` : String(e);
        setError(msg);
      }
    })();
  }, []);

  const content = renderContent(bootstrap, error);

  return (
    <div className="app">
      <header className="app-header">
        <h1>pr-pilot</h1>
        <span className="badge">M0-C</span>
        {bootstrap && (
          <>
            <span className="muted">first run: {String(bootstrap.info.firstRun)}</span>
            <span className="version">
              Electron {bootstrap.info.electronVersion} · Node {bootstrap.info.nodeVersion}
            </span>
          </>
        )}
      </header>
      <main className="app-main">
        <Editor
          height="100%"
          defaultLanguage="markdown"
          value={content}
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

function renderContent(b: BootstrapState | null, err: string | null): string {
  if (err) return `# 启动错误\n\n${err}`;
  if (!b) return '# 加载中...';
  return `# pr-pilot

M0-C 已就绪。typed IPC bridge + 首启 bootstrap + pino 日志 + CSP 全部接通。

## 工作目录

- **应用根**: \`${b.paths.appDir}\`
- **配置**: \`${b.paths.configFile}\`
- **状态**: \`${b.paths.stateDir}\`
- **日志**: \`${b.paths.logsDir}\`
- **规则**: \`${b.paths.rulesDir}\`
- **仓库镜像**: \`${b.paths.reposDir}\`

## 运行环境

- **Electron**: ${b.info.electronVersion}
- **Node**: ${b.info.nodeVersion}
- **平台**: ${b.info.platform}
- **本次启动新建 \`~/.pr-pilot/\`**: ${b.info.firstRun}

## 当前 config.yaml

\`\`\`json
${JSON.stringify(b.config, null, 2)}
\`\`\`

## 下一步

- **M0-D**: pr-agent 可用性探测 + GitHub Actions CI
- **M1**: Bitbucket Server PR 轮询
`;
}
