// The library's own logs can contain lounge tokens and pairing data, so they
// stay off. This logger keeps one line from them: the name of a sender message
// the library doesn't handle (a phone feature such as playback speed would show
// up here). Only the name is logged, never the payload, and only the first time
// it appears: senders repeat some (a 'noop' keepalive every few seconds), which
// would otherwise fill the journal.
const UNHANDLED = /\) Not handled: '([A-Za-z]{1,64})'$/;
// A paired sender chooses the names, so the set of names already logged is capped.
const MAX_LOGGED_NAMES = 100;

export function unhandledMessageLogger(log = console) {
  const logged = new Set();
  return {
    error() {}, warn() {}, info() {}, setLevel() {},
    debug(message) {
      const name = typeof message === 'string' && UNHANDLED.exec(message)?.[1];
      if (!name || logged.has(name) || logged.size >= MAX_LOGGED_NAMES) return;
      logged.add(name);
      log.info(`Unhandled sender message: ${name}`);
    },
  };
}
