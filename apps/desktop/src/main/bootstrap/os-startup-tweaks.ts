import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

// Common CLI install dirs: covers pip --user / npm global / homebrew (Apple Silicon + Intel).
const COMMON_CLI_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
];

/**
 * An app launched by the macOS GUI (Finder / Dock / LaunchServices) is given a **minimal PATH** by
 * launchd (`/usr/bin:/bin:/usr/sbin:/sbin`) and **does not read the user's shell config** (`.zshrc` /
 * `.zprofile`). But local CLIs (claude / codex) are often installed in `~/.local/bin`, homebrew, and
 * other dirs that **only the shell adds to PATH** — so the embedded python's `shutil.which(...)` can't
 * find the command and the local CLI provider fails, yet launching via `npm run dev` from a terminal
 * works fine (it inherits the terminal PATH with config already loaded). Windows is unaffected (GUI
 * processes inherit the user PATH).
 *
 * Prepend the common dirs into `process.env.PATH` (deduplicated, only filling in what the original PATH
 * lacks, keeping the original order after); afterward all child processes (the embedded python and the
 * CLIs it spawns) inherit them via `{ ...process.env }`. The static dirs already cover the most common
 * install locations; no login-shell resolution is run (avoiding startup-time child processes / timeouts
 * / noise). Only called by applyMacStartupTweaks.
 */
function augmentMacPath(): void {
  const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
  const existingSet = new Set(existing);
  const added = COMMON_CLI_DIRS.filter((d) => !existingSet.has(d));
  if (added.length > 0) {
    process.env.PATH = [...added, ...existing].join(':');
  }
}

/**
 * Windows-specific startup tweak: an attached console defaults to the localized OEM page (Simplified
 * Chinese cp936/GBK), which doesn't line up with pino's UTF-8 bytes → garbled Chinese logs in the dev
 * terminal; chcp 65001 switches the output code page to UTF-8 to align. Without a console (packaged),
 * chcp silently fails and is swallowed, no side effects.
 */
function applyWindowsStartupTweaks(): void {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    /* no console / chcp unavailable: ignore, logs are still written as UTF-8 bytes */
  }
}

/**
 * macOS-specific startup tweaks:
 * - use-mock-keychain: the ad-hoc signing identity is unstable (cdhash changes every build), so
 *   os_crypt pops up "access keychain" on every launch; mock makes it use memory without touching the
 *   real keychain. Cost: cookie encryption degrades to a static key, but the key was already stored in
 *   plaintext, so no real loss. Removable once there's a proper Developer ID signature. Must be before
 *   app.whenReady().
 * - Prepend common CLI dirs to PATH (see augmentMacPath): must be before pr-agent probing / running.
 */
function applyMacStartupTweaks(): void {
  app.commandLine.appendSwitch('use-mock-keychain');
  augmentMacPath();
}

/**
 * Process / platform startup tweaks (must run once during module load, before app.whenReady()): first
 * do cross-platform process env adjustments, then delegate to each platform's specific init based on
 * the current platform (see applyWindowsStartupTweaks / applyMacStartupTweaks).
 *
 * Cross-platform: PYTHONDONTWRITEBYTECODE=1 — the embedded python child processes don't drop .pyc (the
 * install dir is per-user writable, and at runtime it would accumulate tens of thousands of
 * __pycache__/.pyc slowing down upgrades/uninstalls); child processes inherit this process's env via
 * spawn. Cost: recompiles on every launch (slightly slower), limited impact.
 */
export function applyOsStartupTweaks(): void {
  process.env.PYTHONDONTWRITEBYTECODE = '1';

  if (process.platform === 'win32') {
    applyWindowsStartupTweaks();
  } else if (process.platform === 'darwin') {
    applyMacStartupTweaks();
  }
}
