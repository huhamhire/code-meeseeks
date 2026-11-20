import type { Finding, ReviewRun } from '@meebox/shared';
import { readReviewPriority } from './review-priority.js';

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function files(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((file): file is string => typeof file === 'string')) {
    return [...new Set(value)];
  }
}

export function parseStructuredReview(text: string):
  | {
      findings: Finding[];
      coverage: NonNullable<ReviewRun['reviewCoverage']>;
    }
  | undefined {
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(text));
  } catch {
    return;
  }
  const issues = record(data?.['review'])?.['key_issues_to_review'];
  const coverage = record(data?.['coverage']);
  const omittedFiles = files(coverage?.['files_not_reviewed']);
  const partialFiles = files(coverage?.['files_partially_reviewed']);
  if (!Array.isArray(issues) || !omittedFiles || !partialFiles) return;

  const findings: Finding[] = [];
  for (const value of issues as unknown[]) {
    const issue = record(value);
    const file = issue?.['relevant_file'];
    const title = issue?.['issue_header'];
    const body = issue?.['issue_content'];
    if (
      typeof file !== 'string' ||
      typeof title !== 'string' ||
      typeof body !== 'string' ||
      !body.trim()
    ) {
      return;
    }
    const start = issue?.['start_line'];
    const end = issue?.['end_line'];
    const priority = readReviewPriority(body);
    findings.push({
      id: `structured-review-${String(findings.length + 1)}`,
      category: 'code-feedback',
      sectionKey: 'code-feedback',
      title,
      ...priority,
      anchor: file
        ? {
            path: file,
            startLine: typeof start === 'number' ? start : undefined,
            endLine: typeof end === 'number' ? end : undefined,
          }
        : undefined,
    });
  }
  return {
    findings,
    coverage: {
      status: omittedFiles.length || partialFiles.length ? 'partial' : 'complete',
      omittedFiles,
      partialFiles,
    },
  };
}
