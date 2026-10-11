// The shrinker: from "this universe broke" to "this is why".
//
// A failing universe typically contains dozens of faults and hundreds of
// operations, nearly all of them irrelevant. Shrinking happens in two moves:
//
//   * Structural: propose a simpler universe — shorter, fewer faults (delta
//     debugging over fault groups), fewer nodes and clients, calmer network —
//     and keep any proposal that still fails *the same way* (same violation
//     signature). Runs are deterministic, so every proposal is a fair test.
//
//   * Resampling: removing an early fault perturbs everything after it (the
//     butterfly effect), so structural shrinking can get stuck. When it does,
//     we generate fresh universes from the *same recipe, made smaller* — only
//     the fault types still present, fewer of them, a shorter run — and
//     structurally shrink any that fail the same way. The smallest wins.

import { runScenario } from './run.js';
import { makeScenario, withoutNodes } from './scenario.js';
import { hash32 } from './rng.js';

export function scenarioSize(s, result) {
  return {
    faults: s.faults.filter((f) => f.type !== 'heal-all').length + (s.triggers || []).length,
    nodes: s.nodes.length,
    clients: s.clients.length,
    duration: s.duration,
    ops: result ? result.stats.ops : undefined,
  };
}

// Lower is simpler: faults dominate, then how much story there is to read.
export function complexity(size) {
  return size.faults * 100 + (size.ops || 0) + size.duration / 100_000 + size.nodes * 5 + size.clients * 5;
}

export function shrink(system, scenario, baseline, { maxRuns = 600, resample = true, onStep } = {}) {
  if (!baseline || baseline.ok) throw new Error('shrink() needs a failing baseline result');
  const budget = { runs: 0, max: maxRuns };
  const first = structural(system, scenario, baseline, budget, onStep);
  let best = first;
  if (resample) {
    for (let round = 0; round < 4 && budget.runs < budget.max; round++) {
      const found = resampleSmaller(system, best, budget, round, onStep);
      if (!found) break;
      const s = structural(system, found.scenario, found.result, budget, onStep);
      if (complexity(s.to) < complexity(best.to)) best = { ...s, steps: [...best.steps, `resampled universe ${found.scenario.seed}`, ...s.steps] };
      else break;
    }
  }
  return {
    scenario: best.scenario,
    result: best.result,
    runs: budget.runs,
    steps: best.steps,
    from: scenarioSize(scenario, baseline),
    to: best.to,
  };
}

// Draw fresh universes from a smaller version of the failing universe's
// recipe. Returns the first that fails the same way and is already simpler.
function resampleSmaller(system, best, budget, round, onStep) {
  const s = best.scenario;
  const sig = best.result.violation.signature;
  const types = new Set();
  for (const f of s.faults) {
    if (f.type === 'partition' || f.type === 'heal') types.add('partition');
    else if (f.type === 'crash' || f.type === 'restart') types.add('crash');
    else if (f.type === 'pause' || f.type === 'resume') types.add('pause');
    else if (f.type === 'clock') types.add('clock');
  }
  for (const t of s.triggers || []) types.add(t.type);
  const target = complexity(best.to);
  const attempts = Math.min(120, budget.max - budget.runs);
  const durationMs = Math.max(400, s.duration / 1000);
  for (let i = 0; i < attempts; i++) {
    const seed = hash32(s.seed, 'resample', round, i);
    // Sweep from "a few faults" to "barely any".
    const want = Math.max(1, Math.round((best.to.faults / 2) * (1 - i / attempts)));
    const cand = makeScenario(system, seed, {
      bugs: s.bugs,
      params: s.params,
      nodes: s.nodes.length,
      clients: Math.max(1, s.clients.length),
      duration: durationMs,
      quiesce: 0,
      faults: [...types],
      gap: durationMs / (want + 1),
      triggers: (s.triggers || []).length ? Math.min(want, (s.triggers || []).length) : false,
    });
    if (s.clients.length === 0) cand.clients = [];
    budget.runs++;
    const r = runScenario(system, cand);
    const hit = !r.ok && r.violation.signature === sig && complexity(scenarioSize(cand, r)) < target;
    onStep?.({ label: 'resample', accepted: hit, runs: budget.runs, size: best.to });
    if (hit) return { scenario: cand, result: r };
  }
  return null;
}

function structural(system, scenario, baseline, budget, onStep) {
  const sig = baseline.violation.signature;
  let best = scenario;
  let bestResult = baseline;
  const maxRuns = budget.max;
  const steps = [];

  const attempt = (label, candidate) => {
    if (budget.runs >= maxRuns || !candidate) return false;
    budget.runs++;
    const r = runScenario(system, candidate);
    const ok = !r.ok && r.violation.signature === sig;
    if (ok) {
      best = candidate;
      bestResult = r;
      steps.push(label);
    }
    onStep?.({ label, accepted: ok, runs: budget.runs, size: scenarioSize(best, bestResult) });
    return ok;
  };

  let progress = true;
  while (progress && budget.runs < maxRuns) {
    progress = false;

    // 1. End the universe shortly after the violation.
    if (sig !== 'liveness') {
      const cut = Math.ceil((bestResult.violation.time + 60_000) / 1000) * 1000;
      if (cut < best.duration) progress = attempt(`end at ${cut / 1e6}s`, truncate(best, cut)) || progress;
    }

    // 2. Drop event-triggered faults one at a time.
    for (let i = (best.triggers || []).length - 1; i >= 0; i--) {
      const triggers = best.triggers.filter((_, j) => j !== i);
      if (attempt('remove trigger', { ...best, triggers })) progress = true;
    }

    // 3. Delta-debug the timed fault groups.
    if (ddminGroups(best, (cand) => attempt('remove faults', cand))) progress = true;

    // 4. Fewer nodes: drop pairs, keeping the cluster odd-sized.
    while (best.nodes.length > 3) {
      let shrunk = false;
      const ns = best.nodes;
      outer: for (let i = ns.length - 1; i >= 0; i--) {
        for (let j = i - 1; j >= 0; j--) {
          if (attempt(`${ns.length - 2} nodes`, withoutNodes(best, [ns[i], ns[j]]))) { shrunk = true; break outer; }
          if (budget.runs >= maxRuns) break outer;
        }
      }
      if (!shrunk) break;
      progress = true;
    }

    // 5. Fewer clients.
    for (let k = 1; k < best.clients.length; k++) {
      if (attempt(`${k} client${k > 1 ? 's' : ''}`, { ...best, clients: best.clients.slice(0, k) })) { progress = true; break; }
    }

    // 6. Calmer network.
    const net = best.network;
    if (net.drop > 0 && attempt('no packet loss', { ...best, network: { ...net, drop: 0 } })) progress = true;
    if (best.network.dup > 0 && attempt('no duplication', { ...best, network: { ...best.network, dup: 0 } })) progress = true;
    if (best.network.latency.tail > 0 &&
      attempt('no latency spikes', { ...best, network: { ...best.network, latency: { ...best.network.latency, tail: 0 } } })) progress = true;

    // 7. Only the key that broke.
    const key = bestResult.violation.key;
    const keys = best.workload?.keys || [];
    if (key && keys.length > 1 && attempt(`only key ${key}`, { ...best, workload: { ...best.workload, keys: [key] } })) progress = true;
    else if (!key && keys.length > 1 && attempt('one key', { ...best, workload: { ...best.workload, keys: keys.slice(0, 1) } })) progress = true;
  }

  return { scenario: best, result: bestResult, steps, to: scenarioSize(best, bestResult) };
}

function truncate(s, end) {
  const healAt = Math.min(s.healAt, end);
  return {
    ...s,
    duration: end,
    healAt,
    faults: s.faults
      .filter((f) => f.at < end && f.type !== 'heal-all')
      .concat(s.healAt < end ? s.faults.filter((f) => f.type === 'heal-all') : []),
  };
}

// Zeller's ddmin over fault groups: try removing big chunks first, then
// smaller ones, keeping whatever removal still reproduces the failure.
function ddminGroups(scenario, test) {
  const groupsOf = (s) => [...new Set(s.faults.filter((f) => f.group > 0).map((f) => f.group))];
  let current = scenario;
  let groups = groupsOf(current);
  let n = 2;
  let changed = false;
  while (groups.length > 0) {
    const size = Math.ceil(groups.length / n);
    let reduced = false;
    for (let i = 0; i < groups.length; i += size) {
      const drop = new Set(groups.slice(i, i + size));
      const cand = { ...current, faults: current.faults.filter((f) => !drop.has(f.group)) };
      if (test(cand)) {
        current = cand;
        groups = groupsOf(current);
        n = Math.max(n - 1, 2);
        reduced = changed = true;
        break;
      }
    }
    if (!reduced) {
      if (size <= 1) break;
      n = Math.min(n * 2, groups.length);
    }
  }
  return changed;
}
