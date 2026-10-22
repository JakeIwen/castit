import { spawn } from 'node:child_process';
import { config } from '../config/receiver-config.mjs';

export function signalGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function runCommand(argv, { timeoutMs = 5000, signal, environment = {} } = {}) {
  return execute(argv, { timeoutMs, signal, env: environment }).then(({ code, exitSignal }) => {
    if (code !== 0) throw new Error(`Command exited ${code ?? exitSignal}`);
  });
}

export function runCommandOutput(argv, { timeoutMs = 5000, signal,
  maxBytes = 1024 * 1024, env = {} } = {}) {
  return execute(argv, { timeoutMs, signal, maxBytes, env }).then(({ code, stdout, stderr }) =>
    ({ code, stdout, stderr }));
}

function capture(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  stream?.on('data', chunk => {
    const kept = chunk.subarray(0, Math.max(0, maxBytes - size));
    if (kept.length) chunks.push(Buffer.from(kept));
    size += kept.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

function execute(argv, { timeoutMs, signal, env, maxBytes }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(argv[0], argv.slice(1), {
      detached: true, stdio: maxBytes === undefined ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...config.sessionEnvironment, ...env },
    });
    const stdout = capture(child.stdout, maxBytes);
    const stderr = capture(child.stderr, maxBytes);
    let timedOut = false;
    let killTimer;
    const terminate = () => {
      if (timedOut) return;
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 500);
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
      // Kill surviving descendants even when the shell exited on TERM first.
      if (timedOut) signalGroup(child.pid, 'SIGKILL');
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      if (timedOut) reject(new Error('Command timeout/cancellation'));
      else resolve({ code, exitSignal, stdout: stdout(), stderr: stderr() });
    });
  });
}
