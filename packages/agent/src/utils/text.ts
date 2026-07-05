/** String processing utilities (domain-agnostic): template placeholder filling, length-based truncation. */

/**
 * Replace `{{name}}` placeholders in the template with vars (literal replacement), and trim the resource file's
 * trailing newline (trimEnd) to align with the original inline string. If any `{{...}}` placeholder remains after
 * replacement, throw—covering missed fills (once externalized there's no compile-time validation, failing early
 * at runtime beats silence).
 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  const leftover = /\{\{[a-zA-Z0-9_]+\}\}/.exec(out);
  if (leftover) throw new Error(`prompt template: unfilled placeholder ${leftover[0]}`);
  return out.trimEnd();
}

/** Trim the string then truncate to at most max chars, ending with an ellipsis if it overflows. */
export function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
