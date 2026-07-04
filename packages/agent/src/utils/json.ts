/**
 * JSON extraction / repair / salvage utilities for LLM text (domain-agnostic): models often emit actions in
 * ```json``` fences or as bare objects, leave newlines in multiline string values unescaped, and merge the
 * summary's verdict JSON into the prose—this group tolerates these common errors. Used by the orchestrator /
 * each step to parse model output.
 */

/** Escape unescaped bare control chars (newline/carriage-return/tab) inside JSON string literals. LLMs often
 *  drop multiline markdown into string values verbatim without escaping newlines, making JSON.parse fail—this
 *  step repairs that common error (without touching structure outside strings). */
function escapeRawControlInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      inStr = !inStr;
      out += ch;
    } else if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Extract the first JSON object from LLM text (tolerates ```json``` fences + bare text), returns null on failure.
 *  For each candidate, parse as-is first, then retry after escaping bare newlines, covering the common case of the
 *  model not escaping multiline strings. */
export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fence?.[1], text]) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    const slice = c.slice(start, end + 1);
    for (const candidate of [slice, escapeRawControlInStrings(slice)]) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        /* try next candidate / next escaping */
      }
    }
  }
  return null;
}

/**
 * Anchored on the trailing `}`, walk back by brace balancing to find the matching opening `{`, returning the
 * start index of the trailing object (-1 if not found). Braces inside string literals disrupt naive balancing,
 * but the summary verdict JSON's reason rarely contains bare `{}`, so this is good enough.
 */
function trailingObjectStart(s: string): number {
  if (!s.endsWith('}')) return -1;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Extract the summary verdict JSON object (`{"verdict":...,"reason":...}`) from the end of the text, returns null
 * on failure. Parses the balanced full trailing object (tolerating bare control chars); used by the summary to
 * separate verdict from prose: the verdict goes through this function, the prose through {@link stripTrailingJson}.
 */
export function extractTrailingJson<T>(s: string): T | null {
  const text = s.trimEnd();
  const start = trailingObjectStart(text);
  if (start < 0) return null;
  const slice = text.slice(start);
  if (!/"(?:recommendation|verdict)"\s*:/.test(slice)) return null;
  for (const candidate of [slice, escapeRawControlInStrings(slice)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Strip the verdict JSON that the model mistakenly merges into / appends by convention at the end of the summary /
 * final (```json {...}``` fence or bare object, removed only when it contains recommendation/verdict), to keep raw
 * JSON from leaking to the user. recommendation is rendered as a verdict badge via its own field. When the trailing
 * object is truncated (no balanced close), fall back to stripping from the dangling `{"verdict"|"recommendation"`
 * start, avoiding half-cut JSON left in the prose.
 */
export function stripTrailingJson(s: string): string {
  let out = s.trimEnd();
  // trailing fenced code block (```json {...}```)
  out = out
    .replace(/\s*```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/i, (m) =>
      /"(?:recommendation|verdict)"\s*:/.test(m) ? '' : m,
    )
    .trimEnd();
  // trailing bare JSON object: anchored on the trailing }, walk back by brace balancing to the matching opening {,
  // delimiting the whole trailing object (not the innermost {).
  const start = trailingObjectStart(out);
  if (start >= 0 && /"(?:recommendation|verdict)"\s*:/.test(out.slice(start))) {
    out = out.slice(0, start).trimEnd();
  } else {
    // truncation fallback: an unclosed dangling `{"verdict"|"recommendation" …` at the end (output truncated by the
    // token limit mid-verdict-JSON) → strip from that start to the end, avoiding half-cut JSON left at the end of the
    // prose. Prose markdown won't produce that literal start, so the mis-strip risk is very low.
    out = out.replace(/\{\s*"(?:recommendation|verdict)"\s*:[\s\S]*$/, '').trimEnd();
  }
  return out;
}

/**
 * Fallback salvage of human-readable prose: when JSON action parsing fails (truncation / unescaped quotes and other
 * unrecoverable cases), pull the `final` / `summary` field value from the raw text with a lax regex and unescape it,
 * never handing the raw JSON action to the user as the answer. Falls back to the raw text only when nothing is found.
 */
export function salvageProse(raw: string): string {
  const m = raw.match(/"(?:final|summary)"\s*:\s*"((?:\\.|[^"\\])*)"?/);
  if (m?.[1]) {
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  return raw.trim();
}
