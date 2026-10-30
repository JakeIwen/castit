// A classic script shares title cleaning with the player button without making
// extension modules web-accessible. Background modules import it for effect.
globalThis.VAN_TV_CLEAN_VIDEO_TITLE = function cleanVideoTitle(value, { page = false, link = false } = {}) {
  if (typeof value !== 'string') return undefined;
  let title = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (page) title = title.replace(/^\(\d+\)\s+/, '').replace(/ - YouTube$/, '').trim();
  if (link && /^\d+(?::\d{2}){1,2}$/.test(title)) return undefined;
  return title.slice(0, 200).trim() || undefined;
};
