import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

function requireValue(valid, key, expected) {
  if (!valid) throw new TypeError(`Local config ${key} must be ${expected}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function hostname(value, key) {
  requireValue(isText(value), key, 'a hostname without a port or URL');
  let url;
  try { url = new URL(`http://${value}`); } catch {}
  requireValue(url?.hostname === value.toLowerCase() && url?.pathname === '/'
    && !url?.port && !url?.username && !url?.password && !url?.search && !url?.hash,
  key, 'a hostname without a port or URL');
  return url.hostname;
}

function videoLibrary(value) {
  if (value === null) return null;
  requireValue(isObject(value), 'receiver.videoLibrary', 'null or an object');
  let url;
  if (isText(value.controlUrl)) {
    try { url = new URL(value.controlUrl); } catch {}
  }
  requireValue(url && ['http:', 'https:'].includes(url.protocol) && url.hostname
    && !url.username && !url.password && !url.hash,
  'receiver.videoLibrary.controlUrl', 'an HTTP(S) URL without credentials or a fragment');
  requireValue(typeof value.unit === 'string' && !/\s/.test(value.unit)
    && /^[a-z0-9_][a-z0-9_.:@-]*\.service$/i.test(value.unit),
    'receiver.videoLibrary.unit', 'a systemd service unit name');
  return Object.freeze({ controlUrl: value.controlUrl, unit: value.unit });
}

function receiverConfig(value) {
  requireValue(isObject(value), 'receiver', 'an object');
  requireValue(typeof value.sshTarget === 'string' && !/\s/.test(value.sshTarget)
    && /^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9_][a-z0-9_.-]*$/i.test(value.sshTarget),
  'receiver.sshTarget', 'an SSH host or user@host target');
  requireValue(Array.isArray(value.hostnames), 'receiver.hostnames', 'an array of hostnames');
  const hostnames = value.hostnames.map((value, index) => hostname(value, `receiver.hostnames[${index}]`));
  requireValue(typeof value.lanAddress === 'string' && isIPv4(value.lanAddress),
    'receiver.lanAddress', 'an IPv4 address for LAN discovery and binding');
  requireValue(isText(value.audioDevice), 'receiver.audioDevice', 'a non-empty mpv audio device');
  requireValue(value.roomCommand === null || (Array.isArray(value.roomCommand)
    && isText(value.roomCommand[0])
    && value.roomCommand.every(argument => typeof argument === 'string' && !argument.includes('\0'))),
  'receiver.roomCommand', 'null or a non-empty argv array of strings');
  return Object.freeze({ sshTarget: value.sshTarget, hostnames: Object.freeze(hostnames),
    lanAddress: value.lanAddress, audioDevice: value.audioDevice,
    roomCommand: value.roomCommand === null ? null : Object.freeze([...value.roomCommand]),
    videoLibrary: videoLibrary(value.videoLibrary) });
}

export function loadLocalConfig(file = process.env.CASTIT_LOCAL_CONFIG ?? new URL('../local.json', import.meta.url)) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`Cannot read local config ${file}: ${error.code || 'read failed'}`); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in local config ${file}`); }
  requireValue(isObject(parsed), 'root', 'an object');
  return receiverConfig(parsed.receiver);
}
