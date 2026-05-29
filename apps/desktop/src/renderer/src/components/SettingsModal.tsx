import { useEffect, useState } from 'react';
import type { AppInfo, AppPaths, Config } from '@pr-pilot/shared';
import { invoke } from '../api';

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  onClose: () => void;
}

export function SettingsModal({ info, paths, config, onClose }: SettingsModalProps) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const [reposDirInput, setReposDirInput] = useState(config.workspace.repos_dir);
  const [savingReposDir, setSavingReposDir] = useState(false);
  const [reposDirSaved, setReposDirSaved] = useState(false);
  const [reposDirError, setReposDirError] = useState<string | null>(null);

  const [totalBytes, setTotalBytes] = useState<number | null>(null);

  useEffect(() => {
    invoke('repo:getTotalSize', undefined)
      .then((r) => setTotalBytes(r.totalBytes))
      .catch(() => setTotalBytes(0));
  }, []);

  const openConfigFile = async (): Promise<void> => {
    setOpening(true);
    setOpenError(null);
    try {
      await invoke('app:openConfigFile', undefined);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const saveReposDir = async (): Promise<void> => {
    if (savingReposDir) return;
    const next = reposDirInput.trim();
    if (!next) return;
    setSavingReposDir(true);
    setReposDirError(null);
    try {
      await invoke('config:setReposDir', { reposDir: next });
      setReposDirSaved(true);
    } catch (e) {
      setReposDirError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingReposDir(false);
    }
  };

  const reposDirChanged = reposDirInput.trim() !== config.workspace.repos_dir;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>设置</h3>
          <button className="btn" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <section className="modal-section">
            <h4>仓库镜像</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">当前 repos_dir</div>
              <div className="modal-kv-val">{paths.reposDir}</div>
              <div className="modal-kv-key">镜像总占用</div>
              <div className="modal-kv-val">
                {totalBytes === null ? '计算中…' : formatBytes(totalBytes)}
              </div>
            </div>
            <div className="settings-edit-row">
              <input
                type="text"
                className="settings-input"
                value={reposDirInput}
                onChange={(e) => {
                  setReposDirInput(e.target.value);
                  setReposDirSaved(false);
                  setReposDirError(null);
                }}
                placeholder="~/.pr-pilot/repos"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveReposDir()}
                disabled={!reposDirChanged || savingReposDir}
              >
                {savingReposDir ? '保存中…' : '保存'}
              </button>
            </div>
            {reposDirSaved && (
              <p className="muted modal-footer">
                已写入 config.yaml。重启应用生效。原 repos_dir
                下的镜像不会自动迁移，请手动移动或下次访问时重新 clone。
              </p>
            )}
            {reposDirError && <p className="error-text">{reposDirError}</p>}
          </section>

          <section className="modal-section">
            <h4>其它工作目录路径</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">应用根</div>
              <div className="modal-kv-val">{paths.appDir}</div>
              <div className="modal-kv-key">配置</div>
              <div className="modal-kv-val">{paths.configFile}</div>
              <div className="modal-kv-key">状态</div>
              <div className="modal-kv-val">{paths.stateDir}</div>
              <div className="modal-kv-key">日志</div>
              <div className="modal-kv-val">{paths.logsDir}</div>
            </div>
          </section>

          <section className="modal-section">
            <h4>轮询</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">间隔</div>
              <div className="modal-kv-val">{config.poller.interval_seconds} 秒</div>
            </div>
          </section>

          <section className="modal-section">
            <h4>连接 ({config.connections.length})</h4>
            {config.connections.length === 0 ? (
              <p className="muted">未配置任何连接。编辑 config.yaml 添加一条。</p>
            ) : (
              <ul className="connection-list">
                {config.connections.map((c) => (
                  <li key={c.id}>
                    <strong>{c.display_name}</strong>{' '}
                    <span className="muted">({c.id})</span>
                    <br />
                    <span className="muted">
                      {c.kind} · {c.base_url} · clone via {c.clone.protocol}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="modal-section">
            <h4>运行环境</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">Electron</div>
              <div className="modal-kv-val">{info.electronVersion}</div>
              <div className="modal-kv-key">Node</div>
              <div className="modal-kv-val">{info.nodeVersion}</div>
              <div className="modal-kv-key">平台</div>
              <div className="modal-kv-val">{info.platform}</div>
              <div className="modal-kv-key">首启</div>
              <div className="modal-kv-val">{String(info.firstRun)}</div>
            </div>
          </section>

          <section className="modal-section">
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={openConfigFile}
                disabled={opening}
              >
                {opening ? '打开中…' : '编辑 config.yaml (其它项)'}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void invoke('app:openDevTools', undefined);
                }}
                title="打开 Electron 开发者工具（分离窗口）"
              >
                打开 DevTools
              </button>
            </div>
            <p className="muted modal-footer">
              连接 / 轮询间隔等需在 config.yaml 里改。M5 计划在 UI 内直接管理。
            </p>
            {openError && <p className="error-text">{openError}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
