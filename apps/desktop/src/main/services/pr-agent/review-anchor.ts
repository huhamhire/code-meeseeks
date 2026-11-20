import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Finding } from '@meebox/shared';

const exec = promisify(execFile);

export async function validateReviewAnchor(
  root: string,
  base: string,
  file: string,
  startLine: number,
  endLine: number,
  signal: AbortSignal,
): Promise<Finding['anchor']> {
  if (
    !path.isAbsolute(file) ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return;
  try {
    const canonicalRoot = await fs.realpath(root);
    const realFile = await fs.realpath(file);
    const relative = path.relative(canonicalRoot, realFile);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      return;
    const repoPath = relative.split(path.sep).join('/');
    const { stdout } = await exec(
      'git',
      [
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=0',
        base,
        'HEAD',
        '--',
        repoPath,
      ],
      { cwd: canonicalRoot, windowsHide: true, signal },
    );
    // The published anchor must land entirely on lines in an added/changed hunk.
    for (const match of stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const first = Number(match[1]);
      const length = Number(match[2] ?? 1);
      if (startLine >= first && endLine < first + length)
        return { path: repoPath, startLine, endLine };
    }
  } catch {
    return;
  }
}
