#!/usr/bin/env node
// Build dist/everett-lab.html — the whole engine and the time-travel lab in
// one self-contained file you can open straight from disk.

import fs from 'node:fs';
import path from 'node:path';
import { buildLabHtml } from '../src/node/bundle.js';
import { ROOT } from '../src/node/systems.js';

const out = path.join(ROOT, 'dist', 'everett-lab.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
const html = buildLabHtml({});
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB)`);
