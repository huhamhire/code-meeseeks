import { execFile } from 'node:child_process';
import path from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import iconv from 'iconv-lite';
import pino, { type Logger, type StreamEntry } from 'pino';
import pinoRoll from 'pino-roll';

export interface LoggerOptions {
  /** Log directory (absolute path), usually AppPaths.logsDir */
  logsDir: string;
  /** Default level: debug in dev, info in prod */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Split a single file by date and keep N historical copies */
  retentionFiles?: number;
  /** Whether to also output to stdout (defaults to true in dev) */
  alsoStdout?: boolean;
  /**
   * dev console prettification (single-line logfmt: `<ISO8601> LEVEL msg k=v k=v` + coloring). **Enabled only when not packaged**:
   * the packaged console keeps raw JSON. Passed in by the caller based on `!app.isPackaged`—the logger package does not depend on
   * Electron and cannot decide on its own. The file stream is always JSON, unaffected by this switch.
   */
  pretty?: boolean;
}

/**
 * Create a root logger. Submodules derive via `root.child({ scope: 'xxx' })`.
 *
 * Structure: multistream + pinoRoll(file) + console stream (on Windows CJK locales,
 * iconv-lite converts UTF-8 → system code page, otherwise PowerShell/cmd renders UTF-8 bytes as
 * GBK/SJIS and produces mojibake). The file stream is always raw UTF-8; only the console is transcoded.
 */
export async function createLogger(opts: LoggerOptions): Promise<Logger> {
  const {
    logsDir,
    level = process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    retentionFiles = 7,
    alsoStdout = process.env.NODE_ENV !== 'production',
    pretty = false,
  } = opts;

  // pino-roll's default export is a factory function returning Promise<Writable>; use it for the file stream,
  // no longer using transport.targets (transport runs in a worker process, and the console-transcoding patch
  // cannot reach the worker's stdout).
  const fileStream = await pinoRoll({
    file: path.join(logsDir, 'meebox.log'),
    frequency: 'daily',
    mkdir: true,
    limit: { count: retentionFiles },
  });

  const streams: StreamEntry[] = [{ level, stream: fileStream }];
  if (alsoStdout) {
    // The console code page only needs probing once, when stdout is enabled (async, hence awaited here).
    const codePage = await detectWindowsConsoleCodePage();
    streams.push({ level, stream: makeConsoleStream(pretty, codePage) });
  }
  return pino({ level }, pino.multistream(streams));
}

/**
 * Console stream. The base is a raw stream ("passthrough / Windows CJK transcode") (the file stream is always UTF-8 JSON, unaffected);
 * when pretty=true (dev) it layers on logfmt prettification: format each JSON record into a **single line**
 * `<ISO8601> LEVEL msg k=v k=v` (Go-style kv, with objects/stacks passed through JSON.stringify to escape newlines,
 * guaranteeing one log entry per physical line, no longer broken up by pino-pretty's multi-line object/stack rendering).
 */
function makeConsoleStream(pretty: boolean, codePage: number | null): Writable {
  const encoding = pickWindowsConsoleEncoding(pretty, codePage);
  const raw: Writable = encoding ? makeTranscodingWritable(encoding) : process.stdout;
  if (!pretty) return raw;
  // pretty means dev human-readable mode: colored by default. Not gated on isTTY—under electron-vite dev, main's stdout
  // is a pipe (isTTY=false), but the receiving terminal can still render ANSI; honoring the NO_COLOR convention allows explicit disabling.
  const colorize = !process.env.NO_COLOR;
  return new Writable({
    write(chunk: Buffer | string, _enc: string, cb: (err?: Error | null) => void) {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try {
        raw.write(formatLogfmt(line, colorize), () => cb(null));
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

const LEVEL_LABEL: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};
// Per-level ANSI SGR (ASCII, unaffected by iconv transcoding): trace gray / debug cyan / info green /
// warn yellow / error bold red / fatal white-on-red badge—the more severe, the more prominent.
const LEVEL_COLOR: Record<number, string> = {
  10: '90',
  20: '36',
  30: '32',
  40: '33',
  50: '1;31',
  60: '1;37;41',
};
// Fields that are pino built-ins / need not be shown as kv
const CORE_KEYS = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v']);

/**
 * Format a single pino JSON record into single-line logfmt text (with trailing \n). Unparseable lines pass through verbatim.
 */
function formatLogfmt(rawLine: string, colorize: boolean): string {
  const text = rawLine.replace(/\n+$/, '');
  if (!text) return '\n';
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`;
  }
  const ts = typeof rec.time === 'number' ? isoLocal(rec.time) : '';
  const levelNum = typeof rec.level === 'number' ? rec.level : 30;
  // Monospace alignment (5 chars): across lines the level column aligns and msg starts at the same position, easier to scan
  const label = (LEVEL_LABEL[levelNum] ?? String(levelNum)).padEnd(5);
  // All fields (including msg) go through logfmt kv uniformly: when msg contains spaces formatValue adds quotes,
  // so its boundary with subsequent fields is no longer ambiguous (matching Go slog's `msg="..."` style). msg goes first to stay prominent.
  const fields: string[] = [];
  if (typeof rec.msg === 'string' && rec.msg) fields.push(`msg=${formatValue(rec.msg)}`);
  for (const k of Object.keys(rec)) {
    if (CORE_KEYS.has(k)) continue;
    fields.push(`${k}=${formatValue(rec[k])}`);
  }
  const color = (code: string, s: string): string => (colorize ? `\x1b[${code}m${s}\x1b[0m` : s);
  const levelStr = LEVEL_COLOR[levelNum] ? color(LEVEL_COLOR[levelNum]!, label) : label;
  return `${color('90', ts)} ${levelStr}${fields.length ? ` ${fields.join(' ')}` : ''}\n`;
}

/** logfmt value: strings containing whitespace / = / " and objects go through JSON.stringify (newlines escaped → single line preserved). */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Local-timezone ISO8601 (with offset + milliseconds), e.g. 2026-06-09T12:23:45.185+08:00. */
function isoLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/**
 * Transcoding stdout stream for Windows + CJK locales: the UTF-8 text output by pino/pino-pretty is encoded to the system
 * code page before writing to process.stdout, avoiding mojibake from PowerShell/cmd rendering UTF-8 as GBK/SJIS.
 */
function makeTranscodingWritable(encoding: string): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc: string, cb: (err?: Error | null) => void) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try {
        const transcoded = iconv.encode(text, encoding);
        process.stdout.write(transcoded, () => cb(null));
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Pick the target console transcoding encoding on Windows. Prefers the **real active code page** probed at startup
 * (`codePage`, from detectWindowsConsoleCodePage):
 *   - 65001 (UTF-8)            → return null, pass through UTF-8 without transcoding (the console is already UTF-8);
 *   - 936/950/932/949 (CJK)    → transcode to the corresponding code page;
 *   - other known ASCII-compatible pages → return null, pass through (Chinese bytes cannot display correctly anyway, transcoding is no help);
 *   - probe failure (null)     → fall back to a locale-based heuristic guess (zh→cp936 / ja→cp932 / ko→cp949).
 *
 * Probing the real code page avoids the fragility of pure locale guessing: if the user has already `chcp 65001` to a UTF-8 console,
 * transcoding to GBK would instead garble the correct output—here the probe returns 65001 → pass through UTF-8.
 *
 * TTY decision: a directly attached terminal (isTTY=true) of course needs transcoding; but in dev (pretty=true) electron-vite
 * pipes main's stdout (isTTY=false), and the downstream is still a CJK code-page terminal—so transcoding is equally required here,
 * otherwise UTF-8 bytes get rendered as GBK/SJIS mojibake. Hence pretty does not gate on isTTY (consistent with the coloring path);
 * only packaged raw JSON (pretty=false) keeps the isTTY guard, so JSON redirected to a pipe / file stays UTF-8.
 *
 * No distinction between simplified and traditional (CP950 vs CP936): the locale fallback branch distinguishes by zh-TW/zh-HK, the probe branch hits the exact page number.
 * Even if the probe/transcoding is wrong, the user can still get the raw UTF-8 from the logs/ file.
 */
function pickWindowsConsoleEncoding(pretty: boolean, codePage: number | null): string | null {
  if (process.platform !== 'win32') return null;
  if (!pretty && !process.stdout.isTTY) return null;
  // Real active code page takes priority. Use CP_MAP on a hit; 65001 / other ASCII-compatible pages fall outside the map → pass through UTF-8.
  if (codePage !== null) {
    return CP_MAP[codePage] ?? null;
  }
  // Probe failed: guess by locale.
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return 'cp950';
  if (locale.startsWith('zh')) return 'cp936';
  if (locale.startsWith('ja')) return 'cp932';
  if (locale.startsWith('ko')) return 'cp949';
  return null;
}

/** CJK code page numbers needing transcoding → iconv-lite encoding names. Those not in the table, such as 65001 (UTF-8), pass through. */
const CP_MAP: Record<number, string> = {
  936: 'cp936',
  950: 'cp950',
  932: 'cp932',
  949: 'cp949',
};

const execFileAsync = promisify(execFile);

/**
 * Probe the current console's active output code page (equivalent to GetConsoleOutputCP). Runs `chcp.com` (the real
 * executable under System32) and parses the page number from its output—`chcp` text such as "活动代码页: 936" / "Active code page: 65001",
 * where only the numeric part is always ASCII, so a regex extracting the digits works regardless of the current page.
 *
 * Non-Windows, a missing command / timeout / parse failure all return null, and the caller falls back to the locale heuristic.
 */
async function detectWindowsConsoleCodePage(): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('chcp.com', { timeout: 2000, windowsHide: true });
    const m = /(\d+)/.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
