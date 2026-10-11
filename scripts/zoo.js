#!/usr/bin/env node
// Regenerate the bug-zoo table in the README: for every planted bug, find the
// first universe that breaks, shrink it, and report what was left.

import { system as raft } from '../examples/raft/index.js';
import { system as leaseLock } from '../examples/lease-lock/index.js';
import { exploreSync } from '../src/explore.js';
import { shrink } from '../src/shrink.js';

const rows = [];
for (const sys of [raft, leaseLock]) {
  for (const bug of Object.keys(sys.bugs)) {
    const ex = exploreSync(sys, { seeds: 20000, bugs: [bug] });
    const f = ex.failures[0];
    if (!f) { rows.push(`| ${sys.name} | \`${bug}\` | not found in ${ex.explored} | | |`); continue; }
    const s = shrink(sys, f.scenario, f.result);
    rows.push(`| ${sys.name} | \`${bug}\` | #${f.seed} (${(ex.elapsed / 1000).toFixed(1)}s) | ` +
      `${s.from.faults} → **${s.to.faults}** | \`${s.result.violation.signature}\` |`);
    process.stderr.write('.');
  }
}
process.stderr.write('\n');
console.log('| system | bug | first broken universe (1 core) | faults: found → shrunk | caught by |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(r);
