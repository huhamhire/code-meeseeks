import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { structuredReviewMarkerAnchor } from '@meebox/poller';
import type { Finding, FindingAnchor, ReviewRun } from '@meebox/shared';

const exec = promisify(execFile);
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function validLineRange(start: number, end: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start;
}

async function readChangedHunks(
  cwd: string,
  base: string,
  head: string,
  repoPath: string,
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await exec(
    'git',
    [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      base,
      head,
      '--',
      repoPath,
    ],
    { cwd, windowsHide: true, signal, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } },
  );
  return stdout;
}

function containsChangedLines(diff: string, start: number, end: number): boolean {
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const first = Number(match[1]);
    const length = Number(match[2] ?? 1);
    if (start >= first && end < first + length) return true;
  }
  return false;
}

export async function validateReviewAnchor(
  root: string,
  base: string,
  file: string,
  startLine: number,
  endLine: number,
  signal: AbortSignal,
): Promise<Finding['anchor']> {
  if (!path.isAbsolute(file) || !validLineRange(startLine, endLine)) return;
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
    // The published anchor must land entirely on lines in an added/changed hunk.
    const diff = await readChangedHunks(canonicalRoot, base, 'HEAD', repoPath, signal);
    if (containsChangedLines(diff, startLine, endLine))
      return { path: repoPath, startLine, endLine };
  } catch {
    return;
  }
}

function recoveryAnchor(finding: Finding): FindingAnchor | undefined {
  const anchor = finding.anchor;
  const file = anchor?.path.trim();
  if (!anchor || !file) return;
  if (finding.inlineAnchorVerified === false && file !== anchor.path) {
    return { ...anchor, path: file };
  }
  if (anchor.startLine === undefined && finding.sectionKey === 'code-feedback') {
    return structuredReviewMarkerAnchor(finding.body, file);
  }
}

/** Recover older structured results without modifying stored runs or fetching remote objects. */
export async function recoverReviewAnchors(
  runs: ReviewRun[],
  getMirror: () => Promise<string | undefined>,
): Promise<ReviewRun[]> {
  if (!runs.some((run) => run.tool === 'review' && run.findings?.some(recoveryAnchor))) return runs;
  const mirror = await getMirror().catch(() => undefined);
  if (!mirror) return runs;
  const diffs = new Map<string, Promise<string>>();
  const signal = AbortSignal.timeout(5_000);
  const localDiff = (base: string, head: string, file: string): Promise<string> => {
    const key = JSON.stringify([base, head, file]);
    const cached = diffs.get(key);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const { stdout } = await exec('git', ['--literal-pathspecs', 'ls-tree', head, '--', file], {
          cwd: mirror,
          windowsHide: true,
          signal,
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        });
        if (!/^100[67][0-7]{2} blob /.test(stdout)) return '';
        return await readChangedHunks(mirror, base, head, file, signal);
      } catch {
        return '';
      }
    })();
    diffs.set(key, pending);
    return pending;
  };
  return Promise.all(
    runs.map(async (run) => {
      const base = run.mergeBaseSha;
      const head = run.scope?.sha ?? run.headSha;
      if (
        run.tool !== 'review' ||
        !run.findings ||
        !base ||
        !head ||
        !objectId.test(base) ||
        !objectId.test(head)
      )
        return run;
      const findings = await Promise.all(
        run.findings.map(async (finding): Promise<Finding> => {
          const recovered = recoveryAnchor(finding);
          const start = recovered?.startLine;
          const end = recovered?.endLine ?? start;
          if (!recovered || start === undefined || end === undefined || !validLineRange(start, end))
            return finding;
          if (!containsChangedLines(await localDiff(base, head, recovered.path), start, end))
            return finding;
          const anchor: FindingAnchor = { path: recovered.path, startLine: start, endLine: end };
          return { ...finding, anchor, inlineAnchorVerified: true };
        }),
      );
      return { ...run, findings };
    }),
  );
}
