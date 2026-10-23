/** @typedef {{enabled: boolean, language: string}} SubtitleSetting */
/** @typedef {{url: string, language: string, automatic: boolean}} SubtitleTrack */
export const DEFAULT_SUBTITLES = Object.freeze({ enabled: false, language: 'en' });
export const SUBTITLE_FORMATS = Object.freeze(['vtt', 'srv3', 'ass', 'srt']);

export function isSubtitleLanguage(value) {
  return typeof value === 'string' && value.toLowerCase() !== 'all'
    && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(value);
}

// Explicit booleans make repeated HTTP requests idempotent. A language alone enables CC.
export function subtitleArguments({ enabled, language } = {}) {
  if (enabled === undefined && language === undefined) return null;
  if (enabled !== undefined && typeof enabled !== 'boolean') return null;
  if (language !== undefined && !isSubtitleLanguage(language)) return null;
  return { enabled: enabled ?? true, ...(language === undefined ? {} : { language: language.toLowerCase() }) };
}

export function savedSubtitles(value) {
  return { enabled: value?.enabled === true,
    language: isSubtitleLanguage(value?.language) ? value.language.toLowerCase() : DEFAULT_SUBTITLES.language };
}

function subtitleUrl(track) {
  if (track.fragments?.length || (track.protocol && !['http', 'https'].includes(track.protocol))) return null;
  try {
    const url = new URL(track.url);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** @returns {SubtitleTrack|null} Uploaded tracks always outrank automatic captions. */
export function selectSubtitle(data, language) {
  for (const [table, automatic] of [[data.subtitles, false], [data.automatic_captions, true]]) {
    const key = Object.keys(table || {}).find(key => key.toLowerCase() === language);
    const tracks = table?.[key];
    if (!Array.isArray(tracks)) continue;
    for (const format of SUBTITLE_FORMATS) {
      const track = tracks.find(track => track?.ext === format && subtitleUrl(track));
      if (track) return Object.freeze({ url: subtitleUrl(track), language, automatic });
    }
  }
  return null;
}
