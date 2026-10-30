// Half-open intervals make adjacent writes merge without an off-by-one at EOF.
export function mergeRanges(ranges, start, end) {
  const result = [];
  for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
    if (range[1] <= range[0]) continue;
    const previous = result.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

export function missingRanges(ranges, start, end) {
  const missing = [];
  let cursor = start;
  for (const [left, right] of ranges) {
    if (left > cursor) missing.push([cursor, Math.min(left, end)]);
    cursor = Math.max(cursor, right);
    if (cursor >= end) break;
  }
  if (cursor < end) missing.push([cursor, end]);
  return missing.filter(([left, right]) => right > left);
}

export const cachedBytes = track => track.ranges.reduce((sum, [start, end]) => sum + end - start, 0);
export const complete = track => Number.isSafeInteger(track.size) && track.size > 0
  && missingRanges(track.ranges, 0, track.size).length === 0;

export function requestRange(header, size) {
  if (!header) return { start: 0, end: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end
    ? { start, end, partial: true } : null;
}
