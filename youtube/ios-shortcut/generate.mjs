import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalConfig, senderConfig } from '../firefox/build/generate-config.mjs';
import { createWorkflow } from './workflow.mjs';

try {
  const configPath = process.env.CASTIT_LOCAL_CONFIG || fileURLToPath(new URL('../local.json', import.meta.url));
  const directory = process.argv[2] || fileURLToPath(new URL('./dist/', import.meta.url));
  const { receiverUrls } = senderConfig(await readLocalConfig(configPath));
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'Van TV.plist');
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, '-'], {
    input: JSON.stringify(createWorkflow(receiverUrls[0])), stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(path);
} catch (error) {
  console.error(`Van TV Shortcut build: ${error.message}`);
  process.exitCode = 1;
}
