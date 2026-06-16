import { execFile } from 'node:child_process';
import path from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import iconv from 'iconv-lite';
import pino, { type Logger, type StreamEntry } from 'pino';
import pinoRoll from 'pino-roll';

export interface LoggerOptions {
  /** 日志目录（绝对路径），通常是 AppPaths.logsDir */
  logsDir: string;
  /** 默认级别：dev 走 debug，prod 走 info */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** 单文件按日期切分，并保留 N 份历史 */
  retentionFiles?: number;
  /** 是否同时输出到 stdout（dev 默认 true） */
  alsoStdout?: boolean;
  /**
   * dev 控制台美化（logfmt 单行：`<ISO8601> LEVEL msg k=v k=v` + 上色）。**仅非打包态开**：
   * 打包态控制台保持原始 JSON。由调用方按 `!app.isPackaged` 传入——logger 包不依赖
   * Electron，无法自行判断。文件流恒为 JSON，不受此开关影响。
   */
  pretty?: boolean;
}

/**
 * 创建一个根 logger。子模块用 `root.child({ scope: 'xxx' })` 派生。
 *
 * 结构：multistream + pinoRoll(file) + 控制台流（Windows 中日韩 locale 走
 * iconv-lite 转 UTF-8 → 系统代码页，否则 PowerShell/cmd 把 UTF-8 字节当
 * GBK/SJIS 渲染会出乱码）。文件流永远是 UTF-8 原文；只有控制台经过转码。
 */
export async function createLogger(opts: LoggerOptions): Promise<Logger> {
  const {
    logsDir,
    level = process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    retentionFiles = 7,
    alsoStdout = process.env.NODE_ENV !== 'production',
    pretty = false,
  } = opts;

  // pino-roll 的默认导出是个工厂函数，返回 Promise<Writable>；用它做文件流，
  // 不再用 transport.targets（transport 在 worker 进程跑，控制台转码 patch
  // 不到 worker 的 stdout）。
  const fileStream = await pinoRoll({
    file: path.join(logsDir, 'meebox.log'),
    frequency: 'daily',
    mkdir: true,
    limit: { count: retentionFiles },
  });

  const streams: StreamEntry[] = [{ level, stream: fileStream }];
  if (alsoStdout) {
    // 控制台代码页只需在 stdout 开启时探一次（async，故在此 await）。
    const codePage = await detectWindowsConsoleCodePage();
    streams.push({ level, stream: makeConsoleStream(pretty, codePage) });
  }
  return pino({ level }, pino.multistream(streams));
}

/**
 * 控制台流。底座是「直出 / Windows CJK 转码」的 raw 流（文件流恒 UTF-8 JSON，不受影响）；
 * pretty=true（dev）时叠加 logfmt 美化：把每条 JSON 记录格式化成**单行**
 * `<ISO8601> LEVEL msg k=v k=v`（Go 风格 kv，对象/堆栈走 JSON.stringify 把换行转义掉，
 * 保证一条日志一物理行，不再被 pino-pretty 的多行对象/堆栈渲染撑断）。
 */
function makeConsoleStream(pretty: boolean, codePage: number | null): Writable {
  const encoding = pickWindowsConsoleEncoding(pretty, codePage);
  const raw: Writable = encoding ? makeTranscodingWritable(encoding) : process.stdout;
  if (!pretty) return raw;
  // pretty 即 dev 人读模式：默认上色。不卡 isTTY——electron-vite dev 下 main 的 stdout
  // 是管道（isTTY=false），但承接的终端仍能渲染 ANSI；遵循 NO_COLOR 约定可显式关闭。
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
// 各级别 ANSI SGR（ASCII，经 iconv 转码不受影响）：trace 灰 / debug 青 / info 绿 /
// warn 黄 / error 粗红 / fatal 白字红底徽标——越严重越醒目。
const LEVEL_COLOR: Record<number, string> = {
  10: '90',
  20: '36',
  30: '32',
  40: '33',
  50: '1;31',
  60: '1;37;41',
};
// pino 内置/无需展示为 kv 的字段
const CORE_KEYS = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v']);

/**
 * 把一条 pino JSON 记录格式化成单行 logfmt 文本（尾带 \n）。无法解析的行原样透传。
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
  // 等宽对齐（5 字符），多行之间级别列对齐、msg 起始位一致，扫读更顺
  const label = (LEVEL_LABEL[levelNum] ?? String(levelNum)).padEnd(5);
  // 全部字段（含 msg）统一走 logfmt kv：msg 自带空格时 formatValue 会加引号，
  // 与后续字段边界不再有歧义（对齐 Go slog 的 `msg="..."` 风格）。msg 排首位保持显眼。
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

/** logfmt 值：含空白 / = / " 的字符串与对象走 JSON.stringify（换行被转义 → 不破单行）。 */
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

/** 本地时区 ISO8601（带偏移 + 毫秒），如 2026-06-09T12:23:45.185+08:00。 */
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
 * Windows + CJK locale 的转码 stdout 流：pino/pino-pretty 输出的 UTF-8 文本按系统
 * 代码页编码后再写 process.stdout，避免 PowerShell/cmd 把 UTF-8 当 GBK/SJIS 渲染出乱码。
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
 * Windows 下挑选控制台转码目标编码。优先用启动时探测到的**真实活动代码页**
 * （`codePage`，来自 detectWindowsConsoleCodePage）：
 *   - 65001 (UTF-8)            → 返回 null，直出 UTF-8 不转码（控制台本就是 UTF-8）；
 *   - 936/950/932/949 (CJK)    → 转码到对应代码页；
 *   - 其它已知 ASCII 兼容页     → 返回 null，直出（中文字节本就无法正确显示，转码无益）；
 *   - 探测失败（null）          → 回落到按 locale 启发式猜（zh→cp936 / ja→cp932 / ko→cp949）。
 *
 * 探测真实代码页避免了纯 locale 猜的脆弱点：用户若已 `chcp 65001` 切到 UTF-8 控制台，
 * 再转码成 GBK 反而把正确输出搞乱——此时探测会返回 65001 → 直出 UTF-8。
 *
 * TTY 判定：直挂终端（isTTY=true）固然要转码；但 dev（pretty=true）下 electron-vite
 * 把 main 的 stdout 接成管道（isTTY=false），下游仍是 CJK 代码页的终端——此时同样必须转码，
 * 否则 UTF-8 字节被当 GBK/SJIS 渲染出乱码。故 pretty 时不卡 isTTY（与上色路径一致）；
 * 仅打包态原始 JSON（pretty=false）保留 isTTY 守卫，让重定向到管道 / 文件的 JSON 维持 UTF-8。
 *
 * 不区分简繁体（CP950 vs CP936）：locale 回落分支按 zh-TW/zh-HK 区分，探测分支按真实页号精确命中。
 * 探测/转码错了用户也能从 logs/ 文件里拿到原始 UTF-8。
 */
function pickWindowsConsoleEncoding(pretty: boolean, codePage: number | null): string | null {
  if (process.platform !== 'win32') return null;
  if (!pretty && !process.stdout.isTTY) return null;
  // 真实活动代码页优先。CP_MAP 命中即用；65001/其它 ASCII 兼容页落到 map 外 → 直出 UTF-8。
  if (codePage !== null) {
    return CP_MAP[codePage] ?? null;
  }
  // 探测失败：按 locale 猜。
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return 'cp950';
  if (locale.startsWith('zh')) return 'cp936';
  if (locale.startsWith('ja')) return 'cp932';
  if (locale.startsWith('ko')) return 'cp949';
  return null;
}

/** 需要转码的 CJK 代码页号 → iconv-lite 编码名。65001 (UTF-8) 等不在表中者直出。 */
const CP_MAP: Record<number, string> = {
  936: 'cp936',
  950: 'cp950',
  932: 'cp932',
  949: 'cp949',
};

const execFileAsync = promisify(execFile);

/**
 * 探测当前控制台的活动输出代码页（GetConsoleOutputCP 等价物）。跑 `chcp.com`（System32 下的
 * 真实可执行文件）解析其输出里的页号——`chcp` 文本如「活动代码页: 936」/「Active code page: 65001」，
 * 仅数字部分恒为 ASCII，故按当前页号无关地用正则抽数字即可。
 *
 * 非 Windows、命令缺失 / 超时 / 解析失败一律返回 null，由调用方回落 locale 启发式。
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
