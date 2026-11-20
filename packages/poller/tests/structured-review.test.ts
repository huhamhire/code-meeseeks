import { describe, expect, it } from 'vitest';
import { parseStructuredReview } from '../src/structured-review.js';

describe('parseStructuredReview', () => {
  it('distinguishes a complete empty review from missing or malformed output', () => {
    expect(
      parseStructuredReview(
        JSON.stringify({
          review: { key_issues_to_review: [] },
          coverage: { files_not_reviewed: [], files_partially_reviewed: [] },
        }),
      ),
    ).toEqual({
      findings: [],
      coverage: { status: 'complete', omittedFiles: [], partialFiles: [] },
    });
    expect(parseStructuredReview('')).toBeUndefined();
    expect(parseStructuredReview('{"review":{"key_issues_to_review":[]}}')).toBeUndefined();
    expect(parseStructuredReview('{"review":')).toBeUndefined();
  });

  it('maps a finding and keeps omitted and clipped files on partial reviews', () => {
    const result = parseStructuredReview(
      JSON.stringify({
        review: {
          key_issues_to_review: [
            {
              relevant_file: 'src/a.ts',
              issue_header: 'Review title',
              issue_content:
                'Review finding\n[review-priority: {"level":"P2","trigger":"empty input","consequence":"request fails"}]',
              start_line: 3,
              end_line: 4,
            },
          ],
        },
        coverage: { files_not_reviewed: ['src/b.ts'], files_partially_reviewed: ['src/c.ts'] },
      }),
    );
    expect(result?.coverage).toEqual({
      status: 'partial',
      omittedFiles: ['src/b.ts'],
      partialFiles: ['src/c.ts'],
    });
    expect(result?.findings[0]).toMatchObject({
      title: 'Review title',
      body: 'Review finding',
      reviewPriority: { level: 'P2', trigger: 'empty input', consequence: 'request fails' },
      anchor: { path: 'src/a.ts', startLine: 3, endLine: 4 },
    });
  });
});
