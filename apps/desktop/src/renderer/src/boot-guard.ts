/**
 * Last-resort guard against a blank window, sitting below React entirely.
 *
 * The root ErrorBoundary covers errors thrown *while rendering*, and main covers the renderer process dying. Between
 * those two lies a gap neither can see: a module that throws while it initializes — i18n, theme, the app bundle itself
 * — takes down the entry module before `createRoot().render()` ever runs. No React means no boundary; the window just
 * stays on its background colour forever, which is the black screen users report and cannot recover from.
 *
 * So this module (imported first, so its side effect is armed before anything else can throw) watches for `#root`
 * staying empty and paints a plain-DOM recovery screen if it does. No React, no i18n, no stylesheet — every one of
 * those is a thing that could be the failure being reported, so the screen depends on none of them.
 */

/** How long to wait for React's first commit before assuming boot failed. Generous: a cold start on a slow machine
 * pulls a sizable bundle, and a false positive would replace a working (if slow) boot with an error screen. */
const BOOT_TIMEOUT_MS = 15_000;

/** Fixed English copy: i18n may itself be the module that failed, and English is the app's fallback language anyway. */
const COPY = {
  title: 'Code Meeseeks failed to start',
  hint: 'The interface could not be loaded. Reloading usually resolves it; if it keeps happening, the details below and the application log (meebox.log) identify the cause.',
  reload: 'Reload',
};

function rootIsEmpty(): boolean {
  const root = document.getElementById('root');
  return !root || root.childElementCount === 0;
}

/** Paint the recovery screen, once — later failures must not stack copies of it on top of each other. */
function showRecovery(detail: string): void {
  if (document.getElementById('boot-guard-screen')) return;
  if (!rootIsEmpty()) return; // The app did render after all; leave the working UI alone.
  const host = document.createElement('div');
  host.id = 'boot-guard-screen';
  // Inline styles on purpose: the stylesheet is part of the app bundle that may have failed to load.
  host.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'padding:16px;background:#1e1e1e;color:#ccc;font:13px/1.5 system-ui,sans-serif;',
  );
  const card = document.createElement('div');
  card.setAttribute('style', 'max-width:560px;width:100%');
  const title = document.createElement('h1');
  title.setAttribute('style', 'margin:0 0 8px;font-size:15px;font-weight:600;color:#eee');
  title.textContent = COPY.title;
  const hint = document.createElement('p');
  hint.setAttribute('style', 'margin:0 0 12px;color:#999');
  hint.textContent = COPY.hint;
  const pre = document.createElement('pre');
  pre.setAttribute(
    'style',
    'margin:0 0 16px;padding:8px;max-height:220px;overflow:auto;background:#181818;' +
      'border:1px solid #333;border-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#999',
  );
  pre.textContent = detail;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(
    'style',
    'padding:4px 12px;background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font:inherit',
  );
  button.textContent = COPY.reload;
  button.addEventListener('click', () => window.location.reload());
  card.append(title, hint, pre, button);
  host.append(card);
  document.body.append(host);
}

// An uncaught error while the app is still blank means boot failed — no need to wait out the timeout. Once the app has
// rendered, the same errors are the app's own business (the root boundary and the log relay handle them), so
// rootIsEmpty() inside showRecovery keeps this from hijacking a working window.
window.addEventListener('error', (e: ErrorEvent) => {
  showRecovery(e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message);
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason: unknown = e.reason;
  showRecovery(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});

// Backstop for a silent failure — a module that never resolves, an import that hangs — where nothing throws at all.
setTimeout(() => {
  showRecovery(`The interface did not render within ${BOOT_TIMEOUT_MS / 1000}s of startup.`);
}, BOOT_TIMEOUT_MS);
