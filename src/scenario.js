// Scenarios: the complete, explicit description of one universe.
//
// A scenario is plain JSON — topology, network weather, disk behaviour,
// workload mix and a timestamped fault schedule — generated from a seed. The
// run is a pure function of it. That makes a failing scenario a portable bug
// report, and it gives the shrinker something concrete to cut down.
//
// Generation uses swarm testing (Groce et al., ISSTA 2012): each universe
// enables a random *subset* of fault types and picks its own intensities.
// Universes with only one or two kinds of chaos explore deeper into those
// interactions than universes where everything happens at once.

import { Rng, hash32 } from './rng.js';
import { ms } from './util.js';

export const FAULT_TYPES = ['partition', 'crash', 'pause', 'clock'];
export const PARTITION_KINDS = ['halves', 'isolate', 'bridge', 'ring', 'oneway'];

export const LATENCY_PROFILES = {
  lan: { min: 0.1, max: 1 },
  dc: { min: 0.5, max: 5 },
  wan: { min: 5, max: 30 },
};

const KEY_NAMES = ['x', 'y', 'z', 'w', 'v'];
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function makeScenario(system, seed, opts = {}) {
  seed = seed >>> 0;
  const d = {
    nodes: 5, clients: [2, 4], duration: 8000, quiesce: 3000,
    liveness: null, opTimeout: 1000, ...(system.defaults || {}),
  };
  // Independent streams per aspect, so pinning one knob (say --nodes 3)
  // leaves the rest of the universe as it was.
  const R = (label) => new Rng(hash32(seed, 'scenario', label));
  const swarm = opts.swarm !== false;

  // ── topology ──
  let nodes, clients;
  if (system.topology) {
    ({ nodes, clients } = system.topology(R('topology'), opts));
  } else {
    const tr = R('topology');
    const nn = opts.nodes ?? (Array.isArray(d.nodes) ? (swarm ? tr.pick(d.nodes) : d.nodes[d.nodes.length - 1]) : d.nodes);
    const nc = opts.clients ?? (Array.isArray(d.clients) ? tr.range(d.clients[0], d.clients[1]) : d.clients);
    nodes = Array.from({ length: nn }, (_, i) => `n${i + 1}`);
    clients = Array.from({ length: nc }, (_, i) => `c${i + 1}`);
  }

  // ── network weather ──
  const nr = R('network');
  const profile = opts.latency ?? (swarm ? nr.pick(['lan', 'dc', 'dc', 'wan']) : 'dc');
  const tail = swarm && nr.chance(0.4) ? nr.pick([0.01, 0.03]) : 0;
  const drop = swarm && nr.chance(0.4) ? round(nr.uniform(0.005, 0.08)) : 0;
  const dup = swarm && nr.chance(0.3) ? round(nr.uniform(0.005, 0.05)) : 0;
  const network = {
    latency: { ...LATENCY_PROFILES[profile], tail, tailMax: 80 },
    drop: opts.drop ?? drop,
    dup: opts.dup ?? dup,
    ...(d.network || {}),
  };

  // ── faults ──
  const fr = R('faults');
  const duration = opts.duration ?? d.duration;
  const quiesce = opts.quiesce ?? Math.min(d.quiesce, duration / 2);
  const healAt = duration - quiesce;
  const targetsFor = (type) => {
    const t = system.targets?.[type];
    return (typeof t === 'function' ? t(nodes) : t) ?? nodes;
  };
  const allowed = (system.faults ?? FAULT_TYPES).filter((t) => targetsFor(t).length > (t === 'partition' ? 1 : 0));
  let types;
  if (opts.faults) types = opts.faults.filter((t) => allowed.includes(t));
  else if (swarm) {
    types = fr.subset(allowed, 0.6);
    if (types.length === 0 && !fr.chance(0.05)) types = [fr.pick(allowed)];
  } else types = allowed;
  let kinds = swarm ? fr.subset(PARTITION_KINDS, 0.6) : PARTITION_KINDS;
  if (kinds.length === 0) kinds = [fr.pick(PARTITION_KINDS)];
  const gap = opts.gap ?? (swarm ? fr.uniform(80, 1200) : 400);
  const maxLen = opts.maxLen ?? (swarm ? fr.uniform(150, 2500) : 1000);
  const diskLoss = opts.diskLoss ?? (fr.chance(0.5) ? 'all' : 'some');

  const faults = [];
  let t = fr.uniform(100, 500);
  let g = 0;
  while (types.length > 0 && t < healAt) {
    const type = fr.pick(types);
    // Skewed toward short faults: a 20ms crash-and-restart is a very different
    // event from a 2s outage, and both are worth having.
    const u = fr.float();
    const end = Math.min(t + 5 + (maxLen - 5) * u * u, healAt);
    const at = ms(t), until = ms(end);
    g++;
    if (type === 'partition') {
      const kind = fr.pick(kinds);
      const cuts = makeCuts(kind, targetsFor('partition'), fr);
      if (cuts.length) {
        faults.push({ at, type: 'partition', kind, cuts, group: g });
        faults.push({ at: until, type: 'heal', group: g });
      }
    } else if (type === 'crash') {
      const node = fr.pick(targetsFor('crash'));
      faults.push({ at, type: 'crash', node, group: g });
      faults.push({ at: until, type: 'restart', node, group: g });
    } else if (type === 'pause') {
      const node = fr.pick(targetsFor('pause'));
      faults.push({ at, type: 'pause', node, group: g });
      faults.push({ at: until, type: 'resume', node, group: g });
    } else if (type === 'clock') {
      const node = fr.pick(targetsFor('clock'));
      const rate = fr.pick([0.25, 0.5, 2, 4]);
      const jump = fr.chance(0.3) ? Math.round(fr.uniform(-300, 300)) : 0;
      faults.push({ at, type: 'clock', node, rate, jump, group: g });
      faults.push({ at: until, type: 'clock', node, rate: 1, jump: 0, group: g });
    }
    t += fr.uniform(0.3, 1.7) * gap;
  }
  faults.push({ at: ms(healAt), type: 'heal-all', group: 0 });
  faults.sort((a, b) => a.at - b.at);

  // ── event-triggered faults ──
  // Random timing almost never lands a crash in the few milliseconds between
  // "node votes" and "node's vote matters". So the nemesis can also strike
  // *right after* a node emits a given event: "crash n2 just after its 3rd
  // vote", "isolate the leader the moment it is elected".
  const xr = R('triggers');
  const triggers = [];
  const triggerKinds = Object.keys(system.triggers || {});
  const triggerTypes = types.filter((t) => t === 'crash' || t === 'pause' || t === 'partition');
  if (opts.triggers !== false && triggerKinds.length && triggerTypes.length && (opts.triggers || !swarm || xr.chance(0.6))) {
    const count = typeof opts.triggers === 'number' ? opts.triggers : xr.range(1, 3);
    for (let i = 0; i < count; i++) {
      const kind = xr.pick(triggerKinds);
      const type = xr.pick(triggerTypes);
      const pool = targetsFor(type === 'partition' ? 'partition' : type);
      const self = pool.length === nodes.length && xr.chance(0.75);
      const u = xr.float();
      triggers.push({
        on: { kind, node: xr.chance(0.5) ? xr.pick(nodes) : null, nth: xr.range(1, system.triggers[kind]) },
        type,
        target: self ? '$emitter' : xr.pick(pool),
        recover: round(2 + 600 * u * u, 1),
        group: ++g,
      });
    }
  }

  // ── workload ──
  const wr = R('workload');
  const nkeys = opts.keys ?? (swarm ? wr.range(1, 4) : 2);
  const workload = {
    keys: KEY_NAMES.slice(0, nkeys),
    reads: round(swarm ? wr.uniform(0.2, 0.6) : 0.4),
    cas: round(swarm ? wr.uniform(0, 0.3) : 0.15),
    think: [0, round(swarm ? wr.uniform(5, 60) : 20, 1)],
    opTimeout: d.opTimeout,
  };

  return {
    everett: 1,
    system: system.name,
    seed,
    nodes,
    clients,
    duration: ms(duration),
    healAt: ms(healAt),
    liveness: d.liveness,
    network,
    disk: { loss: diskLoss },
    workload,
    faults,
    triggers,
    bugs: [...(opts.bugs || [])],
    params: { ...(d.params || {}), ...(opts.params || {}) },
    swarm: { types, kinds, gap: Math.round(gap), maxLen: Math.round(maxLen), profile },
  };
}

export function makeCuts(kind, nodes, rng) {
  const s = rng.shuffle([...nodes]);
  const n = s.length;
  const cuts = [];
  const sever = (A, B) => {
    for (const a of A) for (const b of B) cuts.push([a, b], [b, a]);
  };
  switch (kind) {
    case 'halves': {
      const k = Math.max(1, Math.floor(n / 2));
      sever(s.slice(0, k), s.slice(k));
      break;
    }
    case 'isolate':
      sever([s[0]], s.slice(1));
      break;
    case 'bridge': {
      // s[0] can talk to both sides; the two sides cannot talk to each other.
      const rest = s.slice(1);
      const k = Math.ceil(rest.length / 2);
      sever(rest.slice(0, k), rest.slice(k));
      break;
    }
    case 'ring':
      // Each node hears only its two ring neighbours. Non-transitive.
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dist = Math.min(j - i, n - (j - i));
          if (dist > 1) cuts.push([s[i], s[j]], [s[j], s[i]]);
        }
      }
      break;
    case 'oneway':
      // s[0] still hears everyone, but nobody hears s[0].
      for (const b of s.slice(1)) cuts.push([s[0], b]);
      break;
  }
  return cuts;
}

// Light structural edits used by the shrinker.
export function withoutNodes(scenario, drop) {
  const gone = new Set(drop);
  const keep = (id) => !gone.has(id);
  return {
    ...scenario,
    nodes: scenario.nodes.filter(keep),
    faults: scenario.faults
      .filter((f) => !f.node || keep(f.node))
      .map((f) => (f.cuts ? { ...f, cuts: f.cuts.filter(([a, b]) => keep(a) && keep(b)) } : f))
      .filter((f) => !f.cuts || f.cuts.length > 0),
    triggers: (scenario.triggers || [])
      .filter((x) => keep(x.target) && (!x.on.node || keep(x.on.node))),
  };
}
