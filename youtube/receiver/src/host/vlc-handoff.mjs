import { config } from '../config/receiver-config.mjs';
import { runCommand } from './process-command.mjs';

export async function stopVideoLibrary({ fetcher = fetch, run = runCommand,
  signal, log = console, settings = config } = {}) {
  signal?.throwIfAborted();
  if (settings.videoLibraryUrl === null) return 'disabled';
  // The library runs VLC only under its transient user unit; with that unit
  // inactive there is nothing to stop, and its stop route would just error.
  try { await run(settings.vlcActiveCommand, { signal }); }
  catch { signal?.throwIfAborted(); return 'idle'; }
  const timeout = AbortSignal.timeout(6000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetcher(settings.videoLibraryUrl, {
      method: 'POST', body: new URLSearchParams({ action: 'stop' }), signal: requestSignal,
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error('Library stop rejected');
    // This route bookmarks before Stop + Quit, preserving movie resume position.
    return 'http';
  } catch (error) {
    signal?.throwIfAborted();
    log.warn('Video library stop unavailable; using MPRIS Quit fallback');
  }
  try { await run(settings.vlcQuitCommand, { signal }); }
  catch { log.warn('VLC MPRIS Quit unavailable; checking its user unit'); }
  signal?.throwIfAborted();
  // Stop only the library-owned unit, never all of the user's VLC processes.
  await run(settings.vlcStopCommand, { signal });
  return 'mpris';
}
