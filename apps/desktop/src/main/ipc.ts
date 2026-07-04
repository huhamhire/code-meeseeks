import { ipcMain } from 'electron';
import * as agent from './controllers/agent.js';
import * as app from './controllers/app.js';
import * as config from './controllers/config.js';
import * as pr from './controllers/pr.js';
import { Orchestrator } from './services/agent/index.js';
import {
  createServiceContext,
  setControllerContext,
  type ControllerContext,
  type RegisterDeps,
} from './services/context.js';
import { RunQueue } from './services/pr-agent/index.js';

export type { RegisterDeps } from './services/context.js';

/**
 * Register all IPC handlers. Thin entry: build the shared context → create two cross-domain services (run queue / Agent
 * orchestration) → compose the controller context and install it as a process-level singleton → bind channels one by
 * one per business domain → return the runtime control handle.
 *
 * A controller is a native ipcMain.handle listener (named function `(event, req) => …`, see controllers/<domain>.ts),
 * with dependencies taken via getContext() and no ctx parameter; below they're registered directly as
 * `ipcMain.handle('channel', controller)`, with no wrapper layer.
 */
export function registerIpcHandlers(deps: RegisterDeps): {
  abortAllActiveRuns: () => number;
  runAutopilotIfDue: () => void;
  terminateAgentsForGonePrs: () => void;
  invalidateCommentsCache: (localId: string) => void;
} {
  const base = createServiceContext(deps);
  // run queue: shared by pragent:run (PR domain), Agent orchestration, and AutoPilot.
  const runQueue = new RunQueue(base);
  // Agent orchestration: reuses the run queue to dispatch tool runs (agent low-priority lane).
  const orchestrator = new Orchestrator(base, runQueue);
  // Controller-layer unified context: base context + two cross-domain services, installed as a process-level singleton (controllers take it via getContext()).
  const ctx: ControllerContext = { ...base, runQueue, orchestrator };
  setControllerContext(ctx);

  /*
   * GUI framework interaction
   * App info / window / external open / dialog / log relay / connections and avatars
   */
  ipcMain.handle('app:info', app.readAppInfo); // App / runtime version info (About page)
  ipcMain.handle('app:paths', app.readAppPaths); // Key directory paths (config / agent / logs)
  ipcMain.handle('app:prAgentStatus', app.readPrAgentStatus); // pr-agent probe status (whether ready)
  ipcMain.handle('log:write', app.writeRendererLog); // Relay renderer logs to disk
  ipcMain.handle('window:setControlColors', app.setWindowControlColors); // Renderer pushes theme-derived window-control colors
  ipcMain.handle('app:connections', app.listConnections); // Current active connection summary (Header / status bar)
  ipcMain.handle('app:userAvatar', app.getUserAvatar); // User avatar (two-level memory + disk cache)
  ipcMain.handle('app:openConfigFile', app.openConfigFile); // Open config.yaml
  ipcMain.handle('app:openAgentDir', app.openAgentDir); // Open Agent directory
  ipcMain.handle('app:openDevTools', app.openDevTools); // Open DevTools (detached window)
  ipcMain.handle('app:setBadgeCount', app.setBadgeCount); // Set app badge count (macOS dock)
  ipcMain.handle('app:checkUpdate', app.checkUpdate); // Manually check for updates
  ipcMain.handle('app:getUpdateStatus', app.getUpdateStatus); // Read cached update-check result (hydration)
  ipcMain.handle('app:openExternal', app.openExternal); // Open external link in system browser
  ipcMain.handle('app:openNotificationSettings', app.openNotificationSettings); // macOS open system notification settings
  ipcMain.handle('dialog:pickDirectory', app.pickDirectory); // Native directory picker dialog

  /*
   * PR operations
   * Comments / list / status / merge / mirror / diff / drafts / pr-agent run queue
   */
  ipcMain.handle('comments:reply', pr.replyComment); // Reply to a comment
  ipcMain.handle('comments:create', pr.createComment); // Create a summary comment
  ipcMain.handle('comments:delete', pr.deleteComment); // Delete your own comment
  ipcMain.handle('comments:edit', pr.editComment); // Edit your own comment
  ipcMain.handle('comments:toggleReaction', pr.toggleReaction); // Toggle a comment emoji reaction
  ipcMain.handle('comments:uploadAttachment', pr.uploadAttachment); // Upload a comment image attachment
  ipcMain.handle('comments:fetchAttachment', pr.fetchAttachment); // Fetch a comment inline image (proxied with PAT)
  ipcMain.handle('prs:list', pr.listPrs); // PR list (active connection only)
  ipcMain.handle('prs:listArchived', pr.listArchivedPrs); // Closed (archived) PR list (read-only browsing)
  ipcMain.handle('prs:openByUrl', pr.openPrByUrl); // Open a current-platform PR by URL (locate / fetch archive)
  ipcMain.handle('prs:refresh', pr.refreshPrs); // Poll and refresh immediately
  ipcMain.handle('prs:lastSync', pr.getLastSync); // Most recent sync time
  ipcMain.handle('prs:setLocalStatus', pr.setPrStatus); // Set review status (remote first, then local)
  ipcMain.handle('prs:markRead', pr.markRead); // Mark PR read (advance unread watermark)
  ipcMain.handle('prs:merge', pr.mergePr); // Merge PR
  ipcMain.handle('repo:sync', pr.syncRepo); // Sync the local mirror of the PR's repo
  ipcMain.handle('diff:listChangedFiles', pr.listChangedFiles); // Changed files list
  ipcMain.handle('diff:listConflictFiles', pr.listConflictFiles); // Merge conflict files list (file tree warning)
  ipcMain.handle('diff:getFileContent', pr.getFileContent); // File content (base / head side)
  ipcMain.handle('diff:commentCountCached', pr.getCommentCountCached); // Comment count badge (cache only)
  ipcMain.handle('diff:listComments', pr.listComments); // Fetch comments (cache + in-flight dedup)
  ipcMain.handle('diff:listCommits', pr.listCommits); // Commit list
  ipcMain.handle('diff:listActivity', pr.listActivity); // Review-decision activity events (timeline)
  ipcMain.handle('diff:commitCount', pr.getCommitCount); // Commit count badge (local git)
  ipcMain.handle('diff:getBlame', pr.getBlame); // blame + PR-introduced lines
  ipcMain.handle('repo:getTotalSize', pr.getTotalSize); // Total local mirror usage (settings page)
  ipcMain.handle('drafts:list', pr.getDrafts); // Draft list
  ipcMain.handle('drafts:create', pr.addDraft); // Create a draft
  ipcMain.handle('drafts:update', pr.patchDraft); // Update a draft
  ipcMain.handle('drafts:delete', pr.removeDraft); // Delete a draft
  ipcMain.handle('drafts:publishBatch', pr.publishDraftBatch); // Batch publish drafts to remote
  ipcMain.handle('findingClosures:list', pr.getFindingClosures); // finding closure relations list
  ipcMain.handle('findingClosures:create', pr.addClosure); // Re-review supersede/revoke → close the original finding
  ipcMain.handle('findingClosures:delete', pr.removeClosure); // Undo closure

  /*
   * Config operations
   * Read/write config.yaml (hot effect / draft staging) and connection / proxy test connections
   */
  ipcMain.handle('config:read', config.readConfig); // Read current in-memory config
  ipcMain.handle('config:setReposDir', config.setReposDir); // Set repos directory (takes effect on restart)
  ipcMain.handle('config:setLanguage', config.setLanguage); // Set UI language (hot effect)
  ipcMain.handle('config:setEditorAppearance', config.setEditorAppearance); // Set global theme + font (frontend takes effect immediately, main process sets native themeSource per theme)
  ipcMain.handle('config:setLlm', config.setLlm); // Set LLM Provider config
  ipcMain.handle('config:setAgent', config.setAgent); // Set Agent config (including agent.dir)
  ipcMain.handle('config:setNotifications', config.setNotifications); // Set notification config (system notifications + dock badge)
  ipcMain.handle('agent:setAutopilotEnabled', config.setAutopilotEnabled); // AutoPilot switch
  ipcMain.handle('config:setConnections', config.setConnections); // Set connections (hot-rebuild adapter/poller)
  ipcMain.handle('config:setProxy', config.setProxy); // Set proxy (hot-rebuild adapter)
  ipcMain.handle('config:testProxy', config.testProxy); // Test proxy connection (doesn't write config)
  ipcMain.handle('config:testConnection', config.testConnection); // Test connection (doesn't write config)
  ipcMain.handle('config:autosaveDraft', config.autosaveDraft); // Save connection / LLM draft to disk (doesn't take effect)
  ipcMain.handle('config:setPoller', config.setPoller); // Set poll interval (hot-swap timer)
  ipcMain.handle('config:setMaxConcurrency', config.setMaxConcurrency); // Set review concurrency (hot-swap queue cap)
  ipcMain.handle('config:setService', config.setService); // Set local API service listening (hot-rebuild listener)
  ipcMain.handle('config:generateServiceToken', config.generateServiceToken); // Regenerate API bearer token

  /*
   * Agent interaction
   * Rule matching / review orchestration / free planning / session and ledger reads / pr-agent run queue
   */
  ipcMain.handle('rules:matchForPr', agent.matchRuleForPr); // Look up rules a PR matches
  ipcMain.handle('agent:run', agent.runReview); // One-click review orchestration (describe→review→summarize)
  ipcMain.handle('agent:ask', agent.runPlanning); // Free-planning Agent (conversation is delegation)
  ipcMain.handle('agent:enqueueMessage', agent.enqueueMessage); // Append a user message while running (enqueue / start a new round)
  ipcMain.handle('agent:stop', agent.stopAgent); // Stop the Agent run for a PR
  ipcMain.handle('agent:getSession', agent.getSession); // Read a persisted review session
  ipcMain.handle('agent:getConversation', agent.getConversation); // Read multi-round conversation messages
  ipcMain.handle('agent:getTranscript', agent.getTranscript); // Read Agent process steps
  ipcMain.handle('agent:autopilotLedgers', agent.getAutopilotLedgers); // Batch read AutoPilot review ledgers
  ipcMain.handle('pragent:run', agent.runPragent); // Trigger one pr-agent run (enqueue)
  ipcMain.handle('pragent:cancel', agent.cancelPragent); // Cancel a run
  ipcMain.handle('pragent:queue', agent.getQueue); // Queue snapshot (active + waiting)
  ipcMain.handle('pragent:listRuns', agent.listRuns); // Historical run list (cursor pagination)
  ipcMain.handle('pragent:getRun', agent.getRun); // Query a single run
  ipcMain.handle('pragent:clearRuns', agent.clearRuns); // Clear run history + Agent sessions / ledgers
  ipcMain.handle('pragent:deleteRun', agent.deleteRun); // Delete a single run record

  base.logger.debug('IPC handlers registered');

  return {
    /**
     * Called on app exit: abort all in-progress runs. Each run's AbortController.abort() triggers exec's
     * onAbort → killTree (process-tree-level kill), also terminating python and its grandchild processes like litellm,
     * avoiding orphan processes locking the install directory and causing upgrade install failures. Returns the number
     * of aborted runs, so the caller can decide whether it needs to wait briefly for taskkill to finish.
     */
    abortAllActiveRuns: () => runQueue.abortAllActiveRuns(),
    /** Called by index.ts on each poll tick: when switch + candidates are met, run one AutoPilot pass. */
    runAutopilotIfDue: () => orchestrator.runAutopilotIfDue(),
    /** Called by index.ts on each poll tick: terminate agent operations still running on PRs that were removed / purged. */
    terminateAgentsForGonePrs: () => void orchestrator.terminateAgentsForGonePrs(),
    /**
     * Called by index.ts when polling finds a PR's comments changed (reply / mention): clear that PR's comment cache +
     * broadcast comments:changed, so the Diff inline comments / activity timeline currently showing that PR refetch
     * immediately (comment changes during polling previously only popped a notification, without refreshing the open view).
     */
    invalidateCommentsCache: (localId: string) => void ctx.pr.invalidateCommentsCache(localId),
  };
}
