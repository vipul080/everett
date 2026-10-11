// Resolve a system by built-in name or by path to a module exporting `system`.

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const BUILTIN = {
  raft: path.join(ROOT, 'examples/raft/index.js'),
  'lease-lock': path.join(ROOT, 'examples/lease-lock/index.js'),
  'gossip-register': path.join(ROOT, 'examples/gossip-register/index.js'),
};

export async function loadSystem(nameOrPath = 'raft') {
  let file = BUILTIN[nameOrPath];
  if (!file) {
    file = path.resolve(nameOrPath);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.js');
    if (!fs.existsSync(file)) {
      throw new Error(`unknown system "${nameOrPath}" — use one of: ${Object.keys(BUILTIN).join(', ')}, or a path to a module exporting { system }`);
    }
  }
  const url = pathToFileURL(file).href;
  const mod = await import(url);
  if (!mod.system) throw new Error(`${file} does not export { system }`);
  // Repros record the system by name (built-ins) or by path relative to the
  // working directory, never by an absolute, machine-specific path.
  const ref = BUILTIN[nameOrPath] ? nameOrPath : path.relative(process.cwd(), file).split(path.sep).join('/');
  return { system: mod.system, url, file, ref };
}

export { ROOT };
