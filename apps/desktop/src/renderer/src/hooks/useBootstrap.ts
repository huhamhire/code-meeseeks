import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConnectionSummary } from '@meebox/ipc';
import type { AppInfo, AppPaths, Config, PrAgentStatus, StoredPullRequest } from '@meebox/shared';
import { LLM_CONTEXT_TOKENS_DEFAULT } from '@meebox/shared';
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
  /** Write entry point for the PR list store (usePullRequests): injects the latest list on bootstrap / hot refresh. */
  setPrs: Dispatch<SetStateAction<StoredPullRequest[]>>;
  /** Re-fetch the PR list from cache (usePullRequests): called on poll tick / window focus. */
  reloadPrs: () => Promise<void>;
}

/**
 * App bootstrap and global lifecycle: before the first frame, loads boot (info/paths/config/prAgent + initial
 * PR list + connection summary + last sync) and locks in the UI language; switches at runtime following
 * config.language; subscribes to poll tick (refresh last sync + reload list + top up connection summary) and
 * window focus refresh; and provides a full reload after onboarding completes / connections take effect hot.
 * Derives needsOnboarding for App to decide whether to enter the wizard.
 */
export function useBootstrap({ setPrs, reloadPrs }: UseBootstrapParams): {
  boot: BootstrapState | null;
  fatalError: string | null;
  lastSyncAt: string | null;
  needsOnboarding: boolean;
  completeOnboarding: (result: OnboardingResult) => Promise<void>;
  refreshBootAndPrs: () => Promise<void>;
  /** Optimistically update boot.config (local sync after IPC persists, e.g. switching LLM / AutoPilot / settings page edits). */
  patchConfig: (fn: (config: Config) => Config) => void;
} {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  // Debug only: when localStorage meebox.forceOnboarding='1', force entry into the onboarding wizard without touching config.yaml.
  const [forceOnboarding, setForceOnboarding] = useState(
    () => localStorage.getItem('meebox.forceOnboarding') === '1',
  );

  // Full boot refresh after connection changes (especially switching the active connection): after the active
  // connection changes, main's app:connections / prs:list both change, so a re-fetch is mandatory or boot.connections
  // and the PR list go stale.
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

  // Bootstrap load: fetch all boot data + initial list, first switch the UI language to the target and wait for resources to load, then setBoot to render the main UI.
  useEffect(() => {
    void (async () => {
      try {
        if (!window.api) throw new Error('preload bridge missing: window.api is undefined');
        const [info, paths, config, prAgent, initialPrs, connections, lastSync] = await Promise.all(
          [
            invoke('app:info', undefined),
            invoke('app:paths', undefined),
            invoke('config:read', undefined),
            invoke('app:prAgentStatus', undefined),
            invoke('prs:list', undefined),
            invoke('app:connections', undefined),
            invoke('prs:lastSync', undefined),
          ],
        );
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

  // Runtime language switch (e.g. settings page changes config.language): depends only on config.language.
  // **Must not depend on the whole boot** — poll:tick calls setBoot to refresh fields like connections, so boot
  // frequently gets a new reference; if it depended on boot, every poll would call i18n.changeLanguage(same language)
  // → react-i18next emits languageChanged → t for every useTranslation gets a new reference → any component whose
  // effect depends on t (e.g. InlineCodeContext's effect that grabs code snippets) reruns needlessly, and the embedded
  // Monaco then setSnippet(null)→rebuilds → refresh jitter.
  const configLanguage = boot?.config.language;
  useEffect(() => {
    if (configLanguage === undefined) return;
    const lang = resolveUiLanguage(configLanguage);
    persistLanguage(lang);
    void i18n.changeLanguage(lang);
  }, [configLanguage]);

  // poll tick: refresh "last sync" + reload list (background polling reflects additions/deletions immediately) + top up
  // connection summary (the startup ping only completes after the window is built, so use the first tick to fill in the
  // status bar user/capability bits).
  useEffect(() => {
    if (!window.api) return;
    return subscribe('poll:tick', (info) => {
      setLastSyncAt(info.at);
      void reloadPrs();
      void invoke('app:connections', undefined).then(
        (connections) => setBoot((b) => (b ? { ...b, connections } : b)),
        () => {
          /* summary refresh failure does not affect the main flow */
        },
      );
    });
  }, [reloadPrs]);

  // Proactively refresh the remote when the window regains focus: fetch PR meta; on Bitbucket, after adding a comment /
  // changing status, PR.updatedAt jumps → PrPanel's prUpdatedAt dep fires → force listComments to fetch new comments.
  useEffect(() => {
    if (!boot) return;
    const onFocus = (): void => {
      void (async () => {
        try {
          await invoke('prs:refresh', undefined);
          await reloadPrs();
        } catch {
          // Silent: a focus-triggered refresh failure should not surface an error to the user
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [boot, reloadPrs]);

  // Onboarding complete: persist connection (required) + LLM / cache dir (as needed), then fully reload boot; once
  // boot.config has a valid active connection, needsOnboarding derives to false, the wizard unmounts, and we cut into the main UI.
  const completeOnboarding = useCallback(
    async (result: OnboardingResult): Promise<void> => {
      await invoke('config:setConnections', {
        connections: [result.connection],
        active_connection_id: result.connection.id,
      });
      if (result.llm) {
        await invoke('config:setLlm', {
          llm: {
            profiles: [result.llm],
            active_id: result.llm.id,
            context_tokens: LLM_CONTEXT_TOKENS_DEFAULT,
          },
        });
      }
      const trimmedRepos = result.reposDir.trim();
      // Note: only persist when different from the initial value — compare against the latest read here (the boot closure may be stale), leaving idempotency to main.
      if (trimmedRepos) {
        const cur = await invoke('config:read', undefined);
        if (trimmedRepos !== (cur.workspace.repos_dir ?? '')) {
          await invoke('config:setReposDir', { reposDir: trimmedRepos });
        }
      }
      await refreshBootAndPrs();
      // Clear the debug flag after finishing the wizard, to avoid staying stuck in the wizard after completing in forced mode
      if (forceOnboarding) {
        localStorage.removeItem('meebox.forceOnboarding');
        setForceOnboarding(false);
      }
    },
    [forceOnboarding, refreshBootAndPrs],
  );

  // Gate condition = whether there is a "valid active connection": empty connections / dangling active both trigger the onboarding wizard.
  // Does not rely on a one-time firstRun flag — after the user clears connections, the next entry still returns to the wizard.
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
