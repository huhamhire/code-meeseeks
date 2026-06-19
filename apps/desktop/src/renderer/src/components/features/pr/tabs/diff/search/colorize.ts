import type { RefObject } from 'react';
import { editor as MonacoEditorNs } from 'monaco-editor';
import { languageFor } from '../../../../../../utils/language';
import type { FileResults } from './diff-search';

/**
 * 异步着色：对每个 file 的每条 match.content 用 Monaco colorize 加语法高亮。
 *
 * Monaco colorize 返回带 inline style 的 HTML — 不依赖 monaco theme CSS，
 * dangerouslySetInnerHTML 即可用。串行 file 但并发 line 平衡 throughput vs
 * 启动开销 (一个文件的 language 加载只一次)。
 *
 * session token 检查：search session 已经被新 query 取代时立即放弃，避免
 * setState 到过期结果上
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
    // plaintext 文件没意义着色 — 直接复用原 matches
    if (langId === 'plaintext') {
      out.push(fr);
      continue;
    }
    const colorized = await Promise.all(
      fr.matches.map(async (m) => {
        try {
          const html = await MonacoEditorNs.colorize(m.content, langId, { tabSize: 2 });
          // colorize 输出末尾会加 `<br/>`；裁掉避免行高跳一档
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
