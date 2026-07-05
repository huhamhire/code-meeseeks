/**
 * pino-roll upstream (3.x) ships no .d.ts. This provides a minimal workspace-wide shared declaration;
 * each package imports it as needed by adding `../../typings/**` to the include in tsconfig.json.
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
