import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * In CLI mode /ask sets the subprocess cwd to a one-shot worktree to obtain full file context (see run-executor +
 * pragent-shim cli/install.py). But the reviewed repo may carry its own agent instruction files (project memory for
 * claude / codex / gemini / cursor / copilot), which after the cwd lands are auto-loaded by the CLI and pollute the /ask answer (including potential prompt injection).
 *
 * Here we **blank out (present-but-blank)** these instruction files within the worktree: the file remains, content empty → the CLI loads empty instructions,
 * equivalent to unconfigured. The worktree is discarded after use (cleanup just rm -rf), so in-place rewriting has no side effects; pr-agent's diff uses a commit-level
 * merge-base and doesn't read working-tree state, so blanking doesn't affect the review diff. Only /ask takes this path; describe/review keep a neutral temp dir.
 */

/** Project-memory files matched by filename and blanked at any level (claude / codex / gemini). */
const INSTRUCTION_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']);
/** Directories skipped during recursion (large / unrelated to instructions). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);
/** Fixed-path instruction resource at the root level (relative to worktree root, path.sep normalized). */
const GITHUB_COPILOT = path.join('.github', 'copilot-instructions.md');

/** Whether rel (relative to worktree root) is an instruction file that needs blanking. */
function isInstructionFile(rel: string): boolean {
  if (INSTRUCTION_BASENAMES.has(path.basename(rel))) return true;
  if (rel === GITHUB_COPILOT) return true;
  // Any file under the cursor rules directory `.cursor/rules/**`.
  const parts = rel.split(path.sep);
  if (parts[0] === '.cursor' && parts[1] === 'rules') return true;
  return false;
}

/** Recursively collect all file paths within the worktree (skipping SKIP_DIRS). */
async function collectFiles(dir: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await collectFiles(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
}

/**
 * Blank out the reviewed repo's own agent instruction files within the one-shot worktree. Best-effort: on overall or single-file failure only warn,
 * don't block /ask (worst case falls back to "might read repo instructions", not fatal).
 */
export async function neutralizeWorktreeInstructions(dir: string, logger?: Logger): Promise<void> {
  try {
    const files: string[] = [];
    await collectFiles(dir, files);
    let cleared = 0;
    for (const full of files) {
      if (!isInstructionFile(path.relative(dir, full))) continue;
      try {
        await fs.writeFile(full, '');
        cleared += 1;
      } catch (err) {
        logger?.warn({ err, file: full }, 'failed to neutralize repo instruction file');
      }
    }
    if (cleared > 0)
      logger?.debug({ dir, cleared }, 'neutralized repo instruction files in worktree');
  } catch (err) {
    logger?.warn(
      { err, dir },
      'neutralizeWorktreeInstructions failed; proceeding without sanitize',
    );
  }
}
