import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { AppInfo, AppPaths, Config, PrAgentStatus, StoredPullRequest } from '@pr-pilot/shared';
import { invoke } from './api';

interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  prAgent: PrAgentStatus;
  prs: StoredPullRequest[];
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
        const [info, paths, config, prAgent, prs] = await Promise.all([
          invoke('app:info', undefined),
          invoke('app:paths', undefined),
          invoke('config:read', undefined),
          invoke('app:prAgentStatus', undefined),
          invoke('prs:list', undefined),
        ]);
        setBootstrap({ info, paths, config, prAgent, prs });
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
        <span className="badge">M1-C</span>
        {bootstrap && (
          <>
            <PrAgentBadge status={bootstrap.prAgent} />
            <span className="badge badge-ok">PRs: {bootstrap.prs.length}</span>
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

M1-C 已就绪：state-store + PlatformAdapter + Poller + IPC 全链路打通。

## Pending PRs (本地状态库)

${renderPrSection(b.prs, b.config.connections.length)}

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

**M1-D**：设置页（新增 BBS 连接 + 改轮询间隔）+ 侧边 PR 列表 UI。
`;
}

function renderPrSection(prs: StoredPullRequest[], connectionCount: number): string {
  if (connectionCount === 0) {
    return [
      '_未配置任何连接。M1-D 会在设置页提供新增 Bitbucket Server 连接的入口。_',
      '',
      '当前可手动编辑 `~/.pr-pilot/config.yaml`，在 `connections:` 下加一条：',
      '',
      '```yaml',
      'connections:',
      '  - id: bb-internal',
      '    kind: bitbucket-server',
      '    base_url: https://code.fineres.com',
      '    display_name: 内部 Bitbucket',
      '    auth:',
      '      type: pat',
      '      token: <PAT>',
      '```',
    ].join('\n');
  }
  if (prs.length === 0) {
    return `共 ${connectionCount} 个连接，本地状态库暂无 PR（poller 可能还未首轮完成；查看 \`logs/pr-pilot.log\` 确认）。`;
  }
  const lines = prs
    .slice(0, 20)
    .map(
      (p) =>
        `- **#${p.remoteId}** [${p.repo.projectKey}/${p.repo.repoSlug}] ${p.title}  \n  *${p.author.displayName}* · localStatus=\`${p.localStatus}\` · ${p.sourceRef.displayId} → ${p.targetRef.displayId}`,
    );
  const more = prs.length > 20 ? `\n\n_…共 ${prs.length} 条，仅显示前 20_` : '';
  return lines.join('\n') + more;
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
