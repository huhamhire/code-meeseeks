import { useState } from 'react';
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
            <h4>工作目录</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">应用根</div>
              <div className="modal-kv-val">{paths.appDir}</div>
              <div className="modal-kv-key">配置</div>
              <div className="modal-kv-val">{paths.configFile}</div>
              <div className="modal-kv-key">仓库镜像</div>
              <div className="modal-kv-val">{paths.reposDir}</div>
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
                    <strong>{c.display_name}</strong> <span className="muted">({c.id})</span>
                    <br />
                    <span className="muted">
                      {c.kind} · {c.base_url}
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
            <button
              className="btn btn-primary"
              type="button"
              onClick={openConfigFile}
              disabled={opening}
            >
              {opening ? '打开中…' : '编辑 config.yaml'}
            </button>
            <p className="muted modal-footer">
              修改 config.yaml 后需重启应用生效。M5 计划在 UI 内直接管理连接。
            </p>
            {openError && <p className="error-text">{openError}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
