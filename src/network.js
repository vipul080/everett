// The simulated network: latency with long tails, loss, duplication,
// reordering (a side effect of random latency), and arbitrary — including
// asymmetric and non-transitive — partitions.
//
// Every per-message decision is drawn from hash(seed, link, n) where n is the
// message's sequence number on that directed link. Removing a fault elsewhere
// therefore leaves most messages' fates untouched, which keeps the shrinker
// from wandering off into a different universe.

import { hash6, unit, hashString } from './rng.js';
import { clone } from './util.js';

export const DELIVER = 1;
const NET = hashString('net');

export const DEFAULT_NETWORK = {
  latency: { min: 0.5, max: 5, tail: 0, tailMax: 0 }, // milliseconds
  drop: 0,
  dup: 0,
};

export class Network {
  constructor(world, cfg = {}) {
    this.world = world;
    this.cfg = {
      ...DEFAULT_NETWORK,
      ...cfg,
      latency: { ...DEFAULT_NETWORK.latency, ...(cfg.latency || {}) },
    };
    this.cuts = new Set();
    this.cutList = [];
    this.linkSeq = new Map();
    this.nextId = 0;
    this.sent = 0;
    this.delivered = 0;
    this.dropped = 0;
  }

  setCuts(cuts) {
    this.cutList = cuts.map((c) => [c[0], c[1]]);
    this.cuts = new Set(cuts.map(([a, b]) => a + '>' + b));
  }

  // Partitions only sever node↔node links. Clients sit "outside" the cluster
  // and can reach any node — which is exactly how a client ends up talking to
  // a deposed leader stuck on the wrong side of a partition.
  isCut(from, to) {
    if (this.cuts.size === 0) return false;
    if (from.kind !== 'node' || to.kind !== 'node') return false;
    return this.cuts.has(from.id + '>' + to.id);
  }

  latency(u1, u2) {
    const { min, max, tail, tailMax } = this.cfg.latency;
    let ms = min + u1 * (max - min);
    if (tail > 0 && u2 < tail) ms += (u2 / tail) * tailMax;
    return Math.max(1, Math.round(ms * 1000));
  }

  send(from, toId, msg) {
    const w = this.world;
    const to = w.actors.get(toId);
    if (!to) throw new Error(`send(): unknown destination "${toId}"`);
    const payload = clone(msg);
    const link = from.index * 65536 + to.index;
    const n = (this.linkSeq.get(link) || 0) + 1;
    this.linkSeq.set(link, n);
    const r = (k) => unit(hash6(w.seed, NET, from.index, to.index, n, k));

    this.sent++;
    const id = ++this.nextId;
    w.recorder?.send(id, from, to, payload);

    if (this.isCut(from, to)) return this.drop(id, from, to, 'partition');
    if (this.cfg.drop > 0 && r(1) < this.cfg.drop) return this.drop(id, from, to, 'loss');

    const at = w.now + this.latency(r(2), r(3));
    w.fold(id, from.index, to.index, at);
    w.schedule(at, { type: DELIVER, id, from, to, msg: payload });

    if (this.cfg.dup > 0 && r(4) < this.cfg.dup) {
      const dupId = ++this.nextId;
      const dupAt = w.now + this.latency(r(5), r(6));
      w.recorder?.send(dupId, from, to, payload, id);
      w.fold(dupId, from.index, to.index, dupAt);
      w.schedule(dupAt, { type: DELIVER, id: dupId, from, to, msg: clone(payload) });
    }
  }

  drop(id, from, to, reason) {
    this.dropped++;
    this.world.fold(id, from.index, to.index, 0xdead);
    this.world.recorder?.drop(id, reason);
  }

  deliver(ev) {
    const w = this.world;
    const { from, to } = ev;
    // A partition also eats packets that were already in flight.
    if (this.isCut(from, to)) return this.drop(ev.id, from, to, 'partition');
    if (!to.alive) return this.drop(ev.id, from, to, 'down');
    if (to.paused) { to.deferred.push(ev); return; }
    this.delivered++;
    w.fold(ev.id, to.index, ev.t, 1);
    w.recorder?.deliver(ev.id);
    w.invoke(to, () => to.impl.onMessage?.(from.id, ev.msg));
  }
}
