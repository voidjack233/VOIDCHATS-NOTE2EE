export class InvalidByteRange extends Error {}
export function parseByteRange(value: unknown, size: number): { start: number; end: number; length: number } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !Number.isSafeInteger(size) || size <= 0) throw new InvalidByteRange();
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new InvalidByteRange();
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) throw new InvalidByteRange();
  const start = first ?? Math.max(0, size - last!);
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start >= size || end < start || (first === null && last === 0)) throw new InvalidByteRange();
  return { start, end, length: end - start + 1 };
}
