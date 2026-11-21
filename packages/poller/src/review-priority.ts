import type { Finding } from '@meebox/shared';

const MARKER = /^[ \t]*\[review-priority:[ \t]*([^\r\n]*?)\][ \t]*\r?$/gm;

export function readReviewPriority(body: string): {
  body: string;
  reviewPriority?: Finding['reviewPriority'];
} {
  const markers = [...body.matchAll(MARKER)];
  if (!markers.length) return { body };
  const cleaned = body.replace(MARKER, '').trim();
  if (markers.length !== 1) return { body: cleaned };
  try {
    const data = JSON.parse(markers[0][1]) as {
      level?: unknown;
      trigger?: unknown;
      consequence?: unknown;
    } | null;
    const { level, trigger, consequence } = data ?? {};
    if (
      (level === 'P1' || level === 'P2' || level === 'P3') &&
      typeof trigger === 'string' &&
      trigger.trim() &&
      typeof consequence === 'string' &&
      consequence.trim()
    ) {
      return {
        body: cleaned,
        reviewPriority: {
          level,
          trigger: trigger.trim().slice(0, 500),
          consequence: consequence.trim().slice(0, 500),
        },
      };
    }
  } catch {
    // A malformed optional marker does not invalidate the finding.
  }
  return { body: cleaned };
}
