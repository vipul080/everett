// The multiverse explorer: run universe after universe until one breaks.
//
// exploreSync is for scripts and tests; exploreAsync yields to the event loop
// so a browser tab stays responsive while it searches. For many cores, see
// src/node/parallel.js.

import { makeScenario } from './scenario.js';
import { runScenario } from './run.js';
import { shrink } from './shrink.js';

const clock = () => (globalThis.performance ? performance.now() : Date.now());

export function exploreSync(system, { seeds = 1000, start = 1, bugs = [], overrides = {}, stopOnFirst = true, onUniverse } = {}) {
  const t0 = clock();
  const failures = [];
  let explored = 0;
  for (let i = 0; i < seeds; i++) {
    const seed = start + i;
    const scenario = makeScenario(system, seed, { ...overrides, bugs });
    const result = runScenario(system, scenario);
    explored++;
    onUniverse?.({ seed, result, explored });
    if (!result.ok) {
      failures.push({ seed, scenario, result });
      if (stopOnFirst) break;
    }
  }
  return { explored, failures, elapsed: clock() - t0 };
}

export async function exploreAsync(system, {
  seeds = 1000, start = 1, bugs = [], overrides = {}, stopOnFirst = true,
  onUniverse, shouldStop, sliceMs = 24,
} = {}) {
  const t0 = clock();
  const failures = [];
  let explored = 0;
  let sliceStart = clock();
  for (let i = 0; i < seeds; i++) {
    if (shouldStop?.()) break;
    const seed = start + i;
    const scenario = makeScenario(system, seed, { ...overrides, bugs });
    const result = runScenario(system, scenario);
    explored++;
    onUniverse?.({ seed, result, explored });
    if (!result.ok) {
      failures.push({ seed, scenario, result });
      if (stopOnFirst) break;
    }
    if (clock() - sliceStart > sliceMs) {
      await new Promise((r) => setTimeout(r, 0));
      sliceStart = clock();
    }
  }
  return { explored, failures, elapsed: clock() - t0 };
}

// Shrink a failure and re-run the minimal universe with full recording.
export function investigate(system, failure, { maxRuns = 500, onStep } = {}) {
  const shrunk = shrink(system, failure.scenario, failure.result, { maxRuns, onStep });
  const replay = runScenario(system, shrunk.scenario, { record: true });
  const deterministic = replay.fingerprint === shrunk.result.fingerprint;
  return { ...shrunk, trace: replay.trace, fingerprint: replay.fingerprint, deterministic };
}
