import path from 'node:path';
import { Writable } from 'node:stream';
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
  } = opts;

  // pino-roll 的默认导出是个工厂函数，返回 Promise<Writable>；用它做文件流，
  // 不再用 transport.targets（transport 在 worker 进程跑，控制台转码 patch
  // 不到 worker 的 stdout）。
  const fileStream = await pinoRoll({
    file: path.join(logsDir, 'pr-pilot.log'),
    frequency: 'daily',
    mkdir: true,
    limit: { count: retentionFiles },
  });

  const streams: StreamEntry[] = [{ level, stream: fileStream }];
  if (alsoStdout) {
    streams.push({ level, stream: makeConsoleStream() });
  }
  return pino({ level }, pino.multistream(streams));
}

/**
 * 控制台流。Windows + CJK locale 下 stdout 输出按系统代码页转码；其它平台直
 * 接走 process.stdout（pino 原始 UTF-8 行）。
 */
function makeConsoleStream(): Writable {
  const encoding = pickWindowsConsoleEncoding();
  if (!encoding) {
    // 大多数平台：终端 UTF-8，直接复用 process.stdout
    return process.stdout;
  }
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
 * Windows + CJK locale 下推断当前控制台代码页：
 *   - zh-* → CP936 (GBK)
 *   - ja-* → CP932 (SJIS)
 *   - ko-* → CP949
 * 其它 / 非 Windows / 非 TTY (重定向到管道 / 文件) 返回 null，跳过转码。
 *
 * 不区分简繁体（CP950 vs CP936）：开发者环境一般 GBK 即可，输出失真极少；
 * 错了用户也能从 logs/ 文件里拿到原始 UTF-8。
 */
function pickWindowsConsoleEncoding(): string | null {
  if (process.platform !== 'win32') return null;
  if (!process.stdout.isTTY) return null;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return 'cp950';
  if (locale.startsWith('zh')) return 'cp936';
  if (locale.startsWith('ja')) return 'cp932';
  if (locale.startsWith('ko')) return 'cp949';
  return null;
}
