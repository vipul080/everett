// Everett — deterministic multiverse testing for distributed systems.
//
// Public API. Everything here is plain JavaScript with no dependencies and no
// Node-specific imports: it runs the same in Node, Deno, Bun and the browser.

export { World, CALL, TIMER } from './world.js';
export { Network, DEFAULT_NETWORK } from './network.js';
export { Disk } from './disk.js';
export { Rng, hash32, mix32 } from './rng.js';
export { Recorder } from './trace.js';
export { History, Workload, kvGenerator } from './workload.js';
export { makeScenario, makeCuts, FAULT_TYPES, PARTITION_KINDS, LATENCY_PROFILES } from './scenario.js';
export { runScenario, applyFault } from './run.js';
export { shrink, scenarioSize, complexity } from './shrink.js';
export { exploreSync, exploreAsync, investigate } from './explore.js';
export { narrate, describeFault, describeEvent } from './narrate.js';
export { checkLinearizable } from './checker/linearizability.js';
export { kvModel, models } from './checker/models.js';
export { clone, fmtTime, components } from './util.js';

export const VERSION = '0.1.0';
