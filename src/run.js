// runScenario: build a universe from a scenario, run it, judge it.
//
// Verdicts come from three places, cheapest first:
//   1. monitors — invariants checked live as nodes emit events
//      (e.g. "two leaders in one term"); the run stops at the first breach;
//   2. liveness — after every fault is healed, the system must make progress;
//   3. the linearizability checker over the full client history.

import { World } from './world.js';
import { Recorder } from './trace.js';
import { History, Workload, kvGenerator } from './workload.js';
import { checkLinearizable } from './checker/linearizability.js';
import { fmtTime, hex32 } from './util.js';
import { mix32, hashString } from './rng.js';

export function applyFault(world, f) {
  world.recorder?.fault(f);
  switch (f.type) {
    case 'partition': world.partition(f.cuts); break;
    case 'heal': world.heal(); break;
    case 'crash': world.crash(f.node); break;
    case 'restart': world.restart(f.node); break;
    case 'pause': world.pause(f.node); break;
    case 'resume': world.resume(f.node); break;
    case 'clock': world.setClock(f.node, f.rate, f.jump || 0); break;
    case 'heal-all':
      world.heal();
      world.calmNetwork();
      for (const id of world.nodeIds) {
        world.resume(id);
        world.restart(id);
        const a = world.actors.get(id);
        if (a.clock.rate !== 1) world.setClock(id, 1, 0);
      }
      break;
    default:
      throw new Error(`unknown fault type "${f.type}"`);
  }
}

// Arm the event-triggered faults: each watches the emit stream, counts
// matching events, and strikes once — right after its nth match.
function armTriggers(world, scenario) {
  for (const tr of scenario.triggers || []) {
    let count = 0;
    let fired = false;
    world.hooks.push((e) => {
      if (fired || e.kind !== tr.on.kind || (tr.on.node && e.node !== tr.on.node)) return;
      if (++count !== tr.on.nth) return;
      fired = true;
      if (world.now >= scenario.healAt) return;
      const node = tr.target === '$emitter' ? e.node : tr.target;
      if (!world.actors.has(node) || world.actors.get(node).kind !== 'node') return;
      const cause = { kind: e.kind, node: e.node, nth: tr.on.nth, data: e.data };
      const until = Math.min(world.now + Math.round(tr.recover * 1000), scenario.healAt);
      let start, stop;
      if (tr.type === 'crash') { start = { type: 'crash', node }; stop = { type: 'restart', node }; }
      else if (tr.type === 'pause') { start = { type: 'pause', node }; stop = { type: 'resume', node }; }
      else {
        const cuts = [];
        for (const other of world.nodeIds) if (other !== node) cuts.push([node, other], [other, node]);
        start = { type: 'partition', kind: 'isolate', cuts };
        stop = { type: 'heal' };
      }
      world.at(world.now, () => applyFault(world, { ...start, trigger: cause, group: tr.group }));
      world.at(until, () => applyFault(world, { ...stop, group: tr.group }));
    });
  }
}

const EPOCH = Date.UTC(2030, 0, 1);

export function runScenario(system, scenario, { record = false, snapshots = true, maxEvents, guard = true } = {}) {
  const recorder = record ? new Recorder({ snapshots }) : null;
  const world = new World({
    seed: scenario.seed,
    network: scenario.network,
    diskLoss: scenario.disk?.loss,
    recorder,
    maxEvents,
  });
  const opts = {
    bugs: new Set(scenario.bugs || []),
    params: scenario.params || {},
    scenario,
  };
  for (const id of scenario.nodes) world.addNode(id, (ctx) => system.createNode(ctx, opts));
  for (const id of scenario.clients) world.addClient(id, (ctx) => system.createClient(ctx, opts));
  world.monitors = system.monitors ? system.monitors(opts) : [];
  const history = new History();

  // Determinism guard: while the universe runs, Math.random and Date.now are
  // the universe's, not the host's. Code that reaches for them by accident
  // stays reproducible instead of silently breaking replay.
  const realRandom = Math.random, realNow = Date.now;
  if (guard) {
    Math.random = () => (world.current ? world.current.rng.float() : world.rng.float());
    Date.now = () => EPOCH + Math.floor((world.current ? world.localTime(world.current) : world.now) / 1000);
  }
  try {
    world.start();
    for (const f of scenario.faults) world.at(f.at, () => applyFault(world, f));
    armTriggers(world, scenario);
    if (scenario.clients.length > 0) {
      const w = scenario.workload || {};
      const generator = system.workload ? system.workload(w, opts) : kvGenerator(w);
      new Workload(world, history, {
        generator,
        think: w.think,
        stopAt: scenario.duration - 50_000,
        start: 50_000,
      }).start();
    }
    world.runUntil(scenario.duration);
  } finally {
    if (guard) { Math.random = realRandom; Date.now = realNow; }
  }
  history.finalize();

  if (!world.violation) {
    for (const m of world.monitors) {
      if (!m.onEnd) continue;
      const v = m.onEnd(world);
      if (v) { world.monitorFail(m, v); break; }
    }
  }

  if (!world.violation && scenario.liveness && scenario.clients.length > 0) {
    const deadline = scenario.healAt + scenario.liveness * 1000;
    if (deadline < scenario.duration) {
      const recovered = history.ops.some((o) => o.type === 'ok' && o.complete >= scenario.healAt && o.complete <= deadline);
      if (!recovered) {
        world.violation = {
          signature: 'liveness',
          message: `no client operation succeeded within ${scenario.liveness}ms after every fault was healed at ${fmtTime(scenario.healAt)}`,
          time: deadline,
        };
      }
    }
  }

  let lin = null;
  if (!world.violation && system.model) {
    lin = checkLinearizable(history.ops, system.model);
    if (!lin.ok) {
      const c = lin.culprit;
      world.violation = {
        signature: 'linearizability',
        message: system.model.explain ? system.model.explain(lin) : `history is not linearizable (key ${lin.key})`,
        time: c ? (c.type === 'ok' ? c.complete : c.invoke) : world.now,
        key: lin.key,
        culprit: c ? c.id : null,
        involved: lin.ops.map((o) => o.id),
        linearized: lin.linearized,
      };
    }
  }

  // Fold the history into the fingerprint: same universe ⇒ same hash.
  let fp = world.fp1 ^ world.fp2;
  for (const o of history.ops) {
    fp = mix32(fp ^ hashString(`${o.process}|${o.f}|${o.key}|${JSON.stringify(o.value)}|${o.type}|${JSON.stringify(o.output)}|${o.invoke}|${o.complete}`));
  }

  const ops = history.ops;
  const result = {
    ok: !world.violation,
    violation: world.violation,
    fingerprint: world.fingerprint + hex32(fp),
    stats: {
      ...world.stats,
      ops: ops.length,
      okOps: ops.filter((o) => o.type === 'ok').length,
      infoOps: ops.filter((o) => o.type === 'info').length,
      faults: scenario.faults.length + (scenario.triggers || []).length,
      linSteps: lin ? lin.steps : 0,
      linUnknown: lin ? !!lin.unknown : false,
    },
  };
  if (record) {
    result.trace = {
      ...recorder.toJSON(),
      history: ops,
      violation: world.violation,
      scenario,
      fingerprint: result.fingerprint,
    };
  }
  return result;
}
