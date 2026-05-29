import path from 'node:path';
import pino, { type Logger } from 'pino';

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
 */
export function createLogger(opts: LoggerOptions): Logger {
  const {
    logsDir,
    level = process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    retentionFiles = 7,
    alsoStdout = process.env.NODE_ENV !== 'production',
  } = opts;

  const fileTarget = {
    target: 'pino-roll',
    options: {
      file: path.join(logsDir, 'pr-pilot.log'),
      frequency: 'daily' as const,
      mkdir: true,
      limit: { count: retentionFiles },
    },
    level,
  };

  const stdoutTarget = {
    target: 'pino/file',
    options: { destination: 1 },
    level,
  };

  return pino({
    level,
    transport: {
      targets: alsoStdout ? [fileTarget, stdoutTarget] : [fileTarget],
    },
  });
}
