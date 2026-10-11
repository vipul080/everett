// Jepsen-style workload: a handful of clients, each issuing one operation at a
// time against the cluster, with every invocation and completion written to a
// history. An operation that times out is "info" — it may or may not have
// happened — and the client continues as a fresh logical process, because the
// old operation might still land at any point in the future.

import { Rng, hash32 } from './rng.js';
import { CALL } from './world.js';

export class History {
  constructor() { this.ops = []; }

  invoke(process, client, op, t) {
    const rec = {
      id: this.ops.length, process, client,
      f: op.f, key: op.key, value: op.value,
      invoke: t, complete: null, type: null, output: undefined,
    };
    this.ops.push(rec);
    return rec;
  }

  complete(rec, type, output, t) {
    rec.type = type;
    rec.output = output;
    rec.complete = t;
  }

  finalize() {
    for (const r of this.ops) if (r.type === null) r.type = 'info';
  }
}

export class Workload {
  constructor(world, history, { generator, think = [0, 20], stopAt, start = 0 }) {
    this.world = world;
    this.history = history;
    this.generator = generator;
    this.think = think;
    this.stopAt = stopAt;
    this.start0 = start;
    this.nextProcess = 0;
    this.clients = [];
  }

  start() {
    const w = this.world;
    for (const id of w.clientIds) {
      const actor = w.actors.get(id);
      const c = {
        id, actor,
        process: this.nextProcess++,
        rng: new Rng(hash32(w.seed, 'workload', actor.index)),
        busy: false,
      };
      this.clients.push(c);
      w.at(this.start0 + this.delay(c), () => this.next(c));
    }
  }

  delay(c) {
    const [lo, hi] = this.think;
    return Math.round(c.rng.uniform(lo, hi) * 1000);
  }

  next(c) {
    const w = this.world;
    if (w.now >= this.stopAt || c.busy || !c.actor.alive) return;
    const op = this.generator(c.rng, c.id);
    const rec = this.history.invoke(c.process, c.id, op, w.now);
    c.busy = true;
    let done = false;
    const complete = (res) => {
      if (done) return;
      done = true;
      const type = res && (res.type === 'ok' || res.type === 'fail') ? res.type : 'info';
      this.history.complete(rec, type, res ? res.value : undefined, w.now);
      c.busy = false;
      if (type === 'info') c.process = this.nextProcess++;
      w.at(w.now + this.delay(c), () => this.next(c));
    };
    w.invoke(c.actor, () => c.actor.impl.invoke(op, complete));
  }
}

// A key-value workload over a few registers: reads, blind writes of unique
// values, and compare-and-set. Unique write values make anomalies explainable
// ("this read returned 7, but 7 had been overwritten by 9 before it began").
export function kvGenerator({ keys = ['x', 'y'], reads = 0.4, cas = 0.15 } = {}) {
  let counter = 0;
  const written = new Map(keys.map((k) => [k, []]));
  return (rng) => {
    const key = rng.pick(keys);
    const r = rng.float();
    const hist = written.get(key);
    if (r < reads) return { f: 'get', key };
    if (r < reads + cas && hist.length > 0) {
      const from = rng.pick(hist.slice(-3));
      const to = ++counter;
      hist.push(to);
      return { f: 'cas', key, value: [from, to] };
    }
    const v = ++counter;
    hist.push(v);
    return { f: 'put', key, value: v };
  };
}
