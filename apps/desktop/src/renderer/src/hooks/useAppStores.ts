import { useEffect } from 'react';
import { wireChatRunStore } from '../stores/chat-run-store';
import { wireDraftsStore } from '../stores/drafts-store';
import { wireFindingClosuresStore } from '../stores/finding-closures-store';
import { wireRepoSyncStore } from '../stores/repo-sync-store';

/**
 * Wire the IPC event streams to each global store (mounted at the React tree root, effectively an "app-level hook"):
 * - chatRunStore: pr-agent active run + real-time stdout, ChatPane can read back the run state when switching across PRs
 * - repoSyncStore: repo mirror clone/fetch progress, StatusBar can read the current sync task at any time
 * - draftsStore: after a draft is written to disk, drafts:changed triggers an auto-refresh of the given PR's draft list
 */
export function useAppStores(): void {
  useEffect(() => wireChatRunStore(), []);
  useEffect(() => wireRepoSyncStore(), []);
  useEffect(() => wireDraftsStore(), []);
  useEffect(() => wireFindingClosuresStore(), []);
}
