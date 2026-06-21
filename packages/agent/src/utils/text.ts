/** 字符串处理工具（域无关）：模板占位符填充、按长度截断。 */

/**
 * 用 vars 替换模板里的 `{{name}}` 占位符（字面替换），并去掉资源文件尾换行（trimEnd）以与原内联字符串
 * 对齐。替换后若仍残留 `{{...}}` 占位符即抛错——兜住漏填（外置后没有编译期校验，运行期早失败胜过静默）。
 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  const leftover = /\{\{[a-zA-Z0-9_]+\}\}/.exec(out);
  if (leftover) throw new Error(`prompt template: unfilled placeholder ${leftover[0]}`);
  return out.trimEnd();
}

/** 把字符串 trim 后截到至多 max 字符，超出以省略号收尾。 */
export function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
