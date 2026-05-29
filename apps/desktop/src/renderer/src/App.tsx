import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { AppInfo, AppPaths, Config, PrAgentStatus } from '@pr-pilot/shared';
import { invoke } from './api';

interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  prAgent: PrAgentStatus;
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
        const [info, paths, config, prAgent] = await Promise.all([
          invoke('app:info', undefined),
          invoke('app:paths', undefined),
          invoke('config:read', undefined),
          invoke('app:prAgentStatus', undefined),
        ]);
        setBootstrap({ info, paths, config, prAgent });
      } catch (e) {
        const msg =
          e instanceof Error ? `${e.message}\n\nstack:\n${e.stack ?? '(none)'}` : String(e);
        setError(msg);
      }
    })();
  }, []);

  const content = renderContent(bootstrap, error);

  return (
    <div className="app">
      <header className="app-header">
        <h1>pr-pilot</h1>
        <span className="badge">M0-D</span>
        {bootstrap && (
          <>
            <PrAgentBadge status={bootstrap.prAgent} />
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

function PrAgentBadge({ status }: { status: PrAgentStatus }) {
  if (status.available) {
    return (
      <span className="badge badge-ok" title={status.version}>
        pr-agent: {status.strategy} ({status.probeMs}ms)
      </span>
    );
  }
  return (
    <span className="badge badge-err" title={status.attempts.map((a) => a.error).join('\n')}>
      pr-agent: unavailable
    </span>
  );
}

function renderContent(b: BootstrapState | null, err: string | null): string {
  if (err) return `# 启动错误\n\n${err}`;
  if (!b) return '# 加载中...';
  return `# pr-pilot

M0-D 已就绪。pr-agent 可用性探测 + GitHub Actions CI 接通。

## pr-agent 探测

${renderPrAgentSection(b.prAgent)}

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

## 下一步

M0 全部完成，准备进入 **M1**：Bitbucket Server 接入 + PR 发现。
`;
}

function renderPrAgentSection(status: PrAgentStatus): string {
  if (status.available) {
    return [
      `- **可用** ✅`,
      `- **策略**: \`${status.strategy}\``,
      `- **版本/帮助首行**: \`${status.version}\``,
      `- **探测耗时**: ${status.probeMs}ms`,
    ].join('\n');
  }
  return [
    `- **不可用** ❌`,
    `- **尝试过的策略**:`,
    ...status.attempts.map((a) => `  - \`${a.strategy}\`: ${a.error} (${a.probeMs}ms)`),
    '',
    `安装提示：`,
    `- local CLI: \`pipx install pr-agent\``,
    `- Docker: 安装 Docker Desktop，镜像 \`codiumai/pr-agent\``,
  ].join('\n');
}
