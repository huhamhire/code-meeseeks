/**
 * LLM 文本里的 JSON 提取 / 修复 / 打捞工具（域无关）：模型常把动作以 ```json``` 围栏或裸对象给出，且多行
 * 字符串值不转义换行、收尾误并入判定 JSON——这组函数容这些常见错误。供编排器 / 各 step 解析模型输出。
 */

/** 把 JSON 串字面量内部未转义的裸控制符（换行/回车/制表）补转义。LLM 常把多行 markdown 原样塞进
 *  字符串值而不转义换行，使 JSON.parse 失败——这一步修复该常见错误（不改字符串外的结构）。 */
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

/** 从 LLM 文本里抽第一个 JSON 对象（容 ```json``` 围栏 + 裸文本），失败返回 null。
 *  对每个候选先按原样解析，失败再补转义裸换行重试，兜住模型多行字符串不转义的常见情况。 */
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
        /* 试下一个候选 / 下一种转义 */
      }
    }
  }
  return null;
}

/**
 * 以末尾 `}` 为锚、按花括号配平反找到匹配的起始 `{`，返回尾部对象的起始下标（找不到返回 -1）。
 * 字符串字面量内的花括号会干扰简单配平，但收尾判定 JSON 的 reason 一般不含裸 `{}`，够用。
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
 * 从文本末尾抽出收尾判定 JSON 对象（`{"verdict":...,"reason":...}`），失败返回 null。先按配平的完整尾部
 * 对象解析（容裸控制符），用于 summary 把判定与正文分离：判定走此函数、正文走 {@link stripTrailingJson}。
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
      /* 试下一个候选 */
    }
  }
  return null;
}

/**
 * 去掉模型误并入 / 按约定追加在 summary / final 末尾的判定 JSON（```json {...}``` 围栏或裸对象，仅当含
 * recommendation/verdict 字样才删），避免原始 JSON 暴露给用户。recommendation 走独立字段渲染为判定徽标。
 * 末尾对象被截断（无配平闭合）时按 dangling `{"verdict"|"recommendation"` 起点兜底剥除，避免半截 JSON 残留正文。
 */
export function stripTrailingJson(s: string): string {
  let out = s.trimEnd();
  // 末尾围栏代码块（```json {...}```）
  out = out
    .replace(/\s*```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/i, (m) =>
      /"(?:recommendation|verdict)"\s*:/.test(m) ? '' : m,
    )
    .trimEnd();
  // 末尾裸 JSON 对象：以末尾 } 为锚按花括号配平反找到匹配的起始 {，界定整个尾部对象（非最内层 {）。
  const start = trailingObjectStart(out);
  if (start >= 0 && /"(?:recommendation|verdict)"\s*:/.test(out.slice(start))) {
    out = out.slice(0, start).trimEnd();
  } else {
    // 截断兜底：末尾有未闭合的 dangling `{"verdict"|"recommendation" …`（输出被 token 上限截断在判定 JSON 中途）
    // → 从该起点剥到结尾，避免半截 JSON 残留在正文末尾。正文 markdown 不会出现该字面量起点，误删风险极低。
    out = out.replace(/\{\s*"(?:recommendation|verdict)"\s*:[\s\S]*$/, '').trimEnd();
  }
  return out;
}

/**
 * 兜底打捞人类可读散文：当 JSON 动作解析失败（截断 / 引号未转义等无法恢复时），从原始文本里用宽松
 * 正则捞出 `final` / `summary` 字段值并反转义，绝不把原始 JSON 动作丢给用户当回答。捞不到才退回原文。
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
