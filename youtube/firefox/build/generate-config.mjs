import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readLocalConfig(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing local config: ${path}. Copy ../local.example.json to ../local.json or set CASTIT_LOCAL_CONFIG.`);
    }
    throw new Error(`Cannot read local config: ${path} (${error.code}).`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in local config: ${path}.`); }
}

function senderConfig(local) {
  const senders = local?.senders;
  if (!Array.isArray(senders?.receiverUrls) || senders.receiverUrls.length === 0) {
    throw new Error('senders.receiverUrls must be a non-empty array of HTTP(S) base URLs.');
  }
  const receiverUrls = senders.receiverUrls.map((value, index) => {
    let url;
    try { url = typeof value === 'string' ? new URL(value) : null; }
    catch { /* Report the field, not potentially private config contents. */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)
        || url.username || url.password || url.search || url.hash) {
      throw new Error(`senders.receiverUrls[${index}] must be an HTTP(S) base URL without credentials, query or fragment.`);
    }
    return url.href.replace(/\/+$/, '');
  });
  if (typeof senders.extensionId !== 'string' || !senders.extensionId.trim()) {
    throw new Error('senders.extensionId must be a non-empty string. Keep it unchanged when updating an installed extension.');
  }
  return { receiverUrls, extensionId: senders.extensionId };
}

async function generate(configPath, outputDir) {
  const { receiverUrls, extensionId } = senderConfig(await readLocalConfig(configPath));
  const manifest = JSON.parse(await readFile(new URL('../manifest.template.json', import.meta.url), 'utf8'));
  manifest.browser_specific_settings.gecko.id = extensionId;
  const hosts = receiverUrls.map(value => {
    const url = new URL(value);
    // Firefox host permissions cannot be limited to the receiver's port.
    return `${url.protocol}//${url.hostname}/*`;
  });
  manifest.permissions.push(...new Set(hosts));
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDir, 'local-config.js'),
    `globalThis.VAN_TV_LOCAL = Object.freeze({ receiverUrls: Object.freeze(${JSON.stringify(receiverUrls)}) });\n`);
}

try { await generate(process.argv[2], process.argv[3]); }
catch (error) { console.error(`Van TV build: ${error.message}`); process.exitCode = 1; }
