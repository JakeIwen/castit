// The library's own logs can contain lounge tokens and pairing data, so they
// stay off. This logger keeps one line from them: the name of a sender message
// the library doesn't handle (a phone feature such as playback speed would show
// up here). Only the name is logged, never the payload.
const UNHANDLED = /\) Not handled: '([A-Za-z]{1,64})'$/;

export function unhandledMessageLogger(log = console) {
  return {
    error() {}, warn() {}, info() {}, setLevel() {},
    debug(message) {
      const name = typeof message === 'string' && UNHANDLED.exec(message)?.[1];
      if (name) log.info(`Unhandled sender message: ${name}`);
    },
  };
}
