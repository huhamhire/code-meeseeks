import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * CLI 模式下 /ask 会把子进程 cwd 落到一次性 worktree 以取得完整文件上下文（见 run-executor +
 * pragent-shim cli/install.py）。但被评审仓库可能自带 agent 指令文件（claude / codex / gemini /
 * cursor / copilot 的项目记忆），在 cwd 命中后会被 CLI 自动加载、污染 /ask 回答（含潜在 prompt 注入）。
 *
 * 这里把 worktree 内这些指令文件**清空（present-but-blank）**：文件仍在、内容为空 → CLI 加载到空指令，
 * 等同未配置。worktree 用后即弃（cleanup 直接 rm -rf），就地改写无副作用；pr-agent 的 diff 走 commit 级
 * merge-base，不读工作树状态，故清空不影响评审 diff。仅 /ask 走此路径，describe/review 维持中性临时目录。
 */

/** 按文件名匹配、任意层级都清空的项目记忆文件（claude / codex / gemini）。 */
const INSTRUCTION_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']);
/** 递归时跳过的目录（体积大 / 与指令无关）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);
/** 根级固定路径的指令资源（相对 worktree 根，path.sep 归一）。 */
const GITHUB_COPILOT = path.join('.github', 'copilot-instructions.md');

/** rel（相对 worktree 根）是否属于需清空的指令文件。 */
function isInstructionFile(rel: string): boolean {
  if (INSTRUCTION_BASENAMES.has(path.basename(rel))) return true;
  if (rel === GITHUB_COPILOT) return true;
  // cursor 规则目录 `.cursor/rules/**` 下任意文件。
  const parts = rel.split(path.sep);
  if (parts[0] === '.cursor' && parts[1] === 'rules') return true;
  return false;
}

/** 递归收集 worktree 内全部文件路径（跳过 SKIP_DIRS）。 */
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
 * 清空一次性 worktree 内被评审仓库自带的 agent 指令文件。Best-effort：整体或单文件失败仅 warn，
 * 不阻断 /ask（最坏退回「可能读到仓库指令」，不致命）。
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
