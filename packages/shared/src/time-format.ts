/**
 * House timestamp formatting — deliberately **locale-independent**: a 24-hour clock and an ISO-ordered date
 * (`yyyy-mm-dd`), so timestamps are unambiguous and sortable regardless of the UI language or the OS locale. The
 * app standardizes on this instead of following the system locale or exposing a date/time format setting (see the
 * timestamp design decision). Kept here — shared, pure, dependency-free — so the renderer (and any future
 * consumer) format identically, and so the logic is unit-testable. All fields use the local timezone.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Format an absolute timestamp. Same-day timestamps omit the redundant date and show only the time (`HH:mm:ss`);
 * other days show the full `yyyy-mm-dd HH:mm:ss`. Pass `{ full: true }` to always include the date — e.g. a
 * precise hover tooltip whose whole job is to disambiguate. Accepts an ISO string / millisecond timestamp / Date;
 * an unparseable input is returned as-is (string) or `""` (non-string).
 */
export function formatTimestamp(input: string | number | Date, opts?: { full?: boolean }): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return typeof input === 'string' ? input : '';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay && !opts?.full) return time;
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/** Date only in the house format (`yyyy-mm-dd`); for relative-time fallbacks where the date alone is enough. */
export function formatDate(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return typeof input === 'string' ? input : '';
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
