import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  AppInfo,
  AppPaths,
  Config,
  ConnectionSummary,
  PrAgentStatus,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke, subscribe } from '../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../i18n';
import type { OnboardingResult } from '../components/features/onboarding';

export interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  prAgent: PrAgentStatus;
  connections: ConnectionSummary[];
  lastSyncAt: string | null;
}

interface UseBootstrapParams {
  /** PR 列表 store 的写入口（usePullRequests）：启动 / 热刷新时注入最新列表。 */
  setPrs: Dispatch<SetStateAction<StoredPullRequest[]>>;
  /** 读缓存重拉 PR 列表（usePullRequests）：poll tick / 窗口聚焦时调用。 */
  reloadPrs: () => Promise<void>;
}

/**
 * 应用启动与全局生命周期：首帧前加载 boot（info/paths/config/prAgent + 初始 PR 列表 + 连接摘要 +
 * 最近同步）并定档 UI 语言；运行时跟随 config.language 切换；订阅 poll tick（刷新最近同步 + 重拉
 * 列表 + 补连接摘要）与窗口聚焦刷新；并提供首启向导完成 / 连接热生效后的整体重载。派生 needsOnboarding
 * 供 App 决定是否进向导。
 */
export function useBootstrap({ setPrs, reloadPrs }: UseBootstrapParams): {
  boot: BootstrapState | null;
  fatalError: string | null;
  lastSyncAt: string | null;
  needsOnboarding: boolean;
  completeOnboarding: (result: OnboardingResult) => Promise<void>;
  refreshBootAndPrs: () => Promise<void>;
  /** 乐观更新 boot.config（IPC 写盘后本地同步，如切 LLM / 切 AutoPilot / 设置页改动）。 */
  patchConfig: (fn: (config: Config) => Config) => void;
} {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  // 仅调试用：localStorage 里 meebox.forceOnboarding='1' 时强制进首启向导，不必动 config.yaml。
  const [forceOnboarding, setForceOnboarding] = useState(
    () => localStorage.getItem('meebox.forceOnboarding') === '1',
  );

  // 连接改动（尤其切换活动连接）后整体刷新 boot：活动连接变化后 main 端 app:connections /
  // prs:list 都随之变，必须重拉，否则 boot.connections、PR 列表会过期。
  const refreshBootAndPrs = useCallback(async (): Promise<void> => {
    const [config, connections, freshPrs, lastSync] = await Promise.all([
      invoke('config:read', undefined),
      invoke('app:connections', undefined),
      invoke('prs:list', undefined),
      invoke('prs:lastSync', undefined),
    ]);
    setBoot((b) => (b ? { ...b, config, connections, lastSyncAt: lastSync.at } : b));
    setPrs(freshPrs);
    setLastSyncAt(lastSync.at);
  }, [setPrs]);

  // 启动加载：拉齐 boot 数据 + 初始列表，并先把 UI 语言切到目标并等资源加载完，再 setBoot 渲染主界面。
  useEffect(() => {
    void (async () => {
      try {
        if (!window.api) throw new Error('preload bridge missing: window.api is undefined');
        const [info, paths, config, prAgent, initialPrs, connections, lastSync] = await Promise.all([
          invoke('app:info', undefined),
          invoke('app:paths', undefined),
          invoke('config:read', undefined),
          invoke('app:prAgentStatus', undefined),
          invoke('prs:list', undefined),
          invoke('app:connections', undefined),
          invoke('prs:lastSync', undefined),
        ]);
        const lang = resolveUiLanguage(config.language);
        persistLanguage(lang);
        await i18n.changeLanguage(lang);
        setBoot({ info, paths, config, prAgent, connections, lastSyncAt: lastSync.at });
        setPrs(initialPrs);
        setLastSyncAt(lastSync.at);
      } catch (e) {
        setFatalError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [setPrs]);

  // 运行时语言切换（如设置页改 config.language）：boot 后 language 变化即切换并回写持久化。
  useEffect(() => {
    if (!boot) return;
    const lang = resolveUiLanguage(boot.config.language);
    persistLanguage(lang);
    void i18n.changeLanguage(lang);
  }, [boot]);

  // poll tick：刷新「最近同步」+ 重拉列表（后台轮询新增/删除即时反映）+ 补连接摘要
  // （启动 ping 在建窗后才完成，借首轮 tick 把状态栏用户/能力位补上）。
  useEffect(() => {
    if (!window.api) return;
    return subscribe('poll:tick', (info) => {
      setLastSyncAt(info.at);
      void reloadPrs();
      void invoke('app:connections', undefined).then(
        (connections) => setBoot((b) => (b ? { ...b, connections } : b)),
        () => {
          /* 摘要刷新失败不影响主流程 */
        },
      );
    });
  }, [reloadPrs]);

  // 窗口重新获得焦点时主动 refresh 远端：拉 PR meta，Bitbucket 上加 comment / 改状态后
  // PR.updatedAt 跳变 → PrPanel 的 prUpdatedAt dep 触发 → force listComments 拉新评论。
  useEffect(() => {
    if (!boot) return;
    const onFocus = (): void => {
      void (async () => {
        try {
          await invoke('prs:refresh', undefined);
          await reloadPrs();
        } catch {
          // 静默：focus 触发的刷新失败不该弹错给用户
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [boot, reloadPrs]);

  // 首启向导完成：落盘连接（必）+ LLM / 缓存目录（按需），再整体重载 boot；boot.config 拿到有效
  // active 连接后 needsOnboarding 派生为 false，向导自然卸载、切入主界面。
  const completeOnboarding = useCallback(
    async (result: OnboardingResult): Promise<void> => {
      await invoke('config:setConnections', {
        connections: [result.connection],
        active_connection_id: result.connection.id,
      });
      if (result.llm) {
        await invoke('config:setLlm', {
          llm: { profiles: [result.llm], active_id: result.llm.id },
        });
      }
      const trimmedRepos = result.reposDir.trim();
      // 注意：与初值不同才写盘 —— 这里用最新一次 read 比对（boot 闭包可能旧），交给 main 幂等即可。
      if (trimmedRepos) {
        const cur = await invoke('config:read', undefined);
        if (trimmedRepos !== (cur.workspace.repos_dir ?? '')) {
          await invoke('config:setReposDir', { reposDir: trimmedRepos });
        }
      }
      await refreshBootAndPrs();
      // 走完向导清掉调试 flag，避免强制模式下完成后仍被困在向导
      if (forceOnboarding) {
        localStorage.removeItem('meebox.forceOnboarding');
        setForceOnboarding(false);
      }
    },
    [forceOnboarding, refreshBootAndPrs],
  );

  // gate 条件 = 有无「有效的 active 连接」：连接为空 / active 悬空都触发首启向导。
  // 不依赖一次性 firstRun 标记 —— 用户清空连接后下次进入仍会回到向导。
  const needsOnboarding =
    !!boot &&
    (forceOnboarding ||
      !boot.config.connections.some((c) => c.id === boot.config.active_connection_id));

  const patchConfig = useCallback((fn: (config: Config) => Config): void => {
    setBoot((b) => (b ? { ...b, config: fn(b.config) } : b));
  }, []);

  return {
    boot,
    fatalError,
    lastSyncAt,
    needsOnboarding,
    completeOnboarding,
    refreshBootAndPrs,
    patchConfig,
  };
}
