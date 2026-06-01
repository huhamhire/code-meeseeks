/**
 * pino-roll 上游（3.x）不带 .d.ts。这里给出最小的全 workspace 共享声明，
 * 各包按需在 tsconfig.json 的 include 里加 `../../typings/**` 引入。
 */
declare module 'pino-roll' {
  import type { Writable } from 'node:stream';
  interface PinoRollOptions {
    file: string;
    frequency?: 'daily' | 'hourly' | number;
    mkdir?: boolean;
    limit?: { count?: number; size?: string };
    size?: string;
    extension?: string;
    dateFormat?: string;
    utc?: boolean;
  }
  export default function build(opts: PinoRollOptions): Promise<Writable>;
}
