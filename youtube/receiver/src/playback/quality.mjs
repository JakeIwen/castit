export const DEFAULT_QUALITY = 'auto';
export const QUALITY_OPTIONS = Object.freeze([
  { value: DEFAULT_QUALITY, label: 'Auto' },
  ...[1080, 720, 480, 360].map(height => ({ value: String(height), label: `${height}p` })),
].map(Object.freeze));

/** @typedef {{selected: string, options: ReadonlyArray<{value: string, label: string}>,
 * loading: boolean, error: boolean}} QualityStatus */

const values = new Set(QUALITY_OPTIONS.map(option => option.value));
export const isQuality = value => typeof value === 'string' && values.has(value);
export const savedQuality = value => isQuality(value) ? value : DEFAULT_QUALITY;
export const qualityArguments = ({ quality }) => isQuality(quality) ? { quality } : null;

// Auto retains the installed Pi policy, including its last-resort compatibility
// fallbacks. Explicit choices are strict maximum heights and never exceed 30 fps.
const AUTO_FORMAT = 'bv*[vcodec^=avc1][height=1080][fps<=25]+ba[acodec^=mp4a]/'
  + 'bv*[vcodec^=avc1][height<=720][fps<=30]+ba[acodec^=mp4a]/'
  + 'bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/'
  + 'bv*[vcodec^=vp9][height<=720][fps<=30]+ba/b[height<=720]/best';

export function qualityFormat(quality = DEFAULT_QUALITY) {
  if (!isQuality(quality)) throw new TypeError('Invalid quality');
  if (quality === DEFAULT_QUALITY) return AUTO_FORMAT;
  const cap = `[height<=${quality}][fps<=30]`;
  return [`bv*[vcodec^=avc1]${cap}+ba[acodec^=mp4a]`,
    `b[vcodec^=avc1][acodec^=mp4a]${cap}`, `bv*[vcodec^=avc1]${cap}+ba`,
    `bv*${cap}+ba`, `b${cap}`].join('/');
}

// Validate extractor output too: missing dimensions must not bypass a cap.
export function withinQuality(track, quality) {
  return quality === DEFAULT_QUALITY || (Number.isFinite(track.height) && track.height > 0
    && track.height <= Number(quality) && Number.isFinite(track.fps) && track.fps <= 30);
}
