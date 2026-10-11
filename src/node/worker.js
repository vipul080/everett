// A worker thread that explores a slice of the multiverse.

import { parentPort, workerData } from 'node:worker_threads';
import { makeScenario } from '../scenario.js';
import { runScenario } from '../run.js';

const mod = await import(workerData.systemUrl);
const system = mod.system;

parentPort.on('message', (msg) => {
  if (msg.type !== 'batch') return;
  const results = [];
  for (const seed of msg.seeds) {
    const scenario = makeScenario(system, seed, { ...msg.overrides, bugs: msg.bugs });
    const r = runScenario(system, scenario);
    results.push({
      seed,
      ok: r.ok,
      signature: r.violation?.signature,
      events: r.stats.events,
    });
    if (!r.ok) break;
  }
  parentPort.postMessage({ type: 'results', results });
});

parentPort.postMessage({ type: 'ready' });
