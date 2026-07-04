import type { RefObject } from 'react';
import { editor as MonacoEditorNs } from 'monaco-editor';
import { languageFor } from '../../../../../../utils/language';
import type { FileResults } from './diff-search';

/**
 * Async colorize: apply syntax highlighting via Monaco colorize to each file's every match.content.
 *
 * Monaco colorize returns HTML with inline styles — doesn't depend on monaco theme CSS,
 * usable directly via dangerouslySetInnerHTML. Serial per file but concurrent per line balances throughput vs
 * startup cost (a file's language loads only once).
 *
 * session token check: bail immediately when the search session has been superseded by a new query, to avoid
 * setState onto a stale result
 */
export async function colorizeAll(
  results: FileResults[],
  token: number,
  sessionRef: RefObject<number>,
): Promise<FileResults[]> {
  const out: FileResults[] = [];
  for (const fr of results) {
    if (token !== sessionRef.current) return results;
    const langId = languageFor(fr.file.path);
    // plaintext files aren't worth colorizing — just reuse the original matches
    if (langId === 'plaintext') {
      out.push(fr);
      continue;
    }
    const colorized = await Promise.all(
      fr.matches.map(async (m) => {
        try {
          const html = await MonacoEditorNs.colorize(m.content, langId, { tabSize: 2 });
          // colorize output appends a trailing `<br/>`; trim it to avoid a line-height jump
          return { ...m, colorizedHtml: html.replace(/<br\/?>$/i, '') };
        } catch {
          return m;
        }
      }),
    );
    out.push({ ...fr, matches: colorized });
  }
  return out;
}
