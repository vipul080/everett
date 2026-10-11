// The World: a single-threaded, discrete-event universe.
//
// Everything that could make a distributed system nondeterministic — time,
// randomness, message delivery order, disk durability, process scheduling —
// is owned by the World and derived from one 32-bit seed. Given the same seed
// and the same scenario, a run is bit-for-bit identical, every time, on every
// machine. That is the whole trick: once a bug is caught in a universe, it can
// be replayed forever.

import { Rng, hash32, hash6, mix32, unit, hashString } from './rng.js';
import { Heap } from './heap.js';
import { Disk } from './disk.js';
import { Network, DELIVER } from './network.js';
import { hex32 } from './util.js';

export const TIMER = 2;
export const CALL = 3;
const US = 1000;
const DISK = hashString('disk');

export class World {
  constructor(opts = {}) {
    this.seed = (opts.seed ?? 1) >>> 0;
    this.rng = new Rng(hash32(this.seed, 'world'));
    this.now = 0;
    this.seq = 0;
    this.queue = new Heap();
    this.actors = new Map();
    this.actorList = [];
    this.nodeIds = [];
    this.clientIds = [];
    this.monitors = [];
    this.hooks = [];
    this.violation = null;
    this.stopped = false;
    this.events = 0;
    this.maxEvents = opts.maxEvents ?? 3_000_000;
    this.diskLoss = opts.diskLoss ?? 'all';
    this.recorder = opts.recorder ?? null;
    if (this.recorder) this.recorder.attach(this);
    this.network = new Network(this, opts.network);
    this.current = null;
    this.fp1 = 0x6a09e667;
    this.fp2 = 0xbb67ae85;
  }

  // ── actors ────────────────────────────────────────────────────────────────

  addNode(id, factory) { return this.addActor(id, 'node', factory); }
  addClient(id, factory) { return this.addActor(id, 'client', factory); }

  addActor(id, kind, factory) {
    if (this.actors.has(id)) throw new Error(`duplicate actor id "${id}"`);
    const a = {
      id, kind, factory,
      index: this.actorList.length,
      impl: null, ctx: null,
      alive: false, inc: 0, crashes: 0,
      timers: new Map(), timerSeq: 0,
      disk: kind === 'node' ? new Disk() : null,
      paused: false, deferred: [],
      clock: { base: 0, local: 0, rate: 1 },
      rng: null,
    };
    this.actors.set(id, a);
    this.actorList.push(a);
    (kind === 'node' ? this.nodeIds : this.clientIds).push(id);
    return a;
  }

  start() {
    Object.freeze(this.nodeIds);
    Object.freeze(this.clientIds);
    for (const a of this.actorList) this.boot(a);
  }

  boot(a) {
    a.alive = true;
    a.inc++;
    a.rng = new Rng(hash32(this.seed, 'actor', a.index, a.inc));
    a.ctx = this.makeContext(a);
    this.recorder?.life(a, a.inc === 1 ? 'boot' : 'restart');
    this.invoke(a, () => {
      a.impl = a.factory(a.ctx);
      a.impl.onStart?.();
    });
  }

  makeContext(a) {
    const world = this;
    const inc = a.inc;
    const live = () => a.alive && a.inc === inc;
    const disk = a.disk;
    const ctx = {
      id: a.id,
      kind: a.kind,
      nodes: this.nodeIds,
      clients: this.clientIds,
      peers: this.nodeIds.filter((n) => n !== a.id),
      now: () => world.localTime(a) / US,
      random: () => a.rng.float(),
      randomInt: (lo, hi) => a.rng.range(lo, hi),
      send: (to, msg) => { if (live()) world.network.send(a, to, msg); },
      setTimer: (delayMs, fn) => (live() ? world.setTimer(a, delayMs, fn) : -1),
      cancelTimer: (id) => { if (id !== null && id !== undefined) a.timers.delete(id); },
      emit: (kind, data) => { if (live()) world.emit(a, kind, data); },
      log: (...args) => { if (live()) world.recorder?.log(a, args); },
      disk: disk && Object.freeze({
        get: (k) => disk.get(k),
        has: (k) => disk.has(k),
        set: (k, v) => { if (live()) disk.set(k, v); },
        delete: (k) => { if (live()) disk.delete(k); },
        fsync: () => { if (live()) disk.fsync(); },
      }),
    };
    return Object.freeze(ctx);
  }

  // ── time & scheduling ─────────────────────────────────────────────────────

  localTime(a) {
    return a.clock.local + (this.now - a.clock.base) * a.clock.rate;
  }

  schedule(t, ev) {
    ev.t = t;
    ev.seq = ++this.seq;
    this.queue.push(ev);
  }

  at(t, fn) { this.schedule(t, { type: CALL, fn }); }

  setTimer(a, delayMs, fn) {
    if (!(delayMs >= 0)) throw new Error(`setTimer(): bad delay ${delayMs}`);
    if (typeof fn !== 'function') throw new Error('setTimer(): callback must be a function');
    const id = ++a.timerSeq;
    a.timers.set(id, fn);
    // Timers run on the node's (possibly skewed) local clock.
    const real = Math.max(1, Math.round((delayMs * US) / a.clock.rate));
    this.schedule(this.now + real, { type: TIMER, actor: a, inc: a.inc, id });
    return id;
  }

  fold(a, b, c, d) {
    this.fp1 = hash6(this.fp1, a >>> 0, b >>> 0, c >>> 0, d >>> 0, 0x51);
    this.fp2 = mix32(this.fp2 ^ hash6(d >>> 0, c >>> 0, b >>> 0, a >>> 0, this.fp2, 0x7a));
  }

  get fingerprint() { return hex32(this.fp1) + hex32(this.fp2); }

  runUntil(tEnd) {
    const q = this.queue;
    while (!this.stopped) {
      const ev = q.peek();
      if (!ev || ev.t > tEnd) break;
      q.pop();
      this.now = ev.t;
      this.dispatch(ev);
      if (++this.events > this.maxEvents) {
        this.fail('event-storm', `event budget exhausted after ${this.maxEvents} events — livelock or message storm?`);
      }
    }
    if (!this.stopped) this.now = Math.max(this.now, tEnd);
  }

  dispatch(ev) {
    switch (ev.type) {
      case DELIVER:
        return this.network.deliver(ev);
      case TIMER: {
        const a = ev.actor;
        if (!a.alive || a.inc !== ev.inc) return;
        if (a.paused) { a.deferred.push(ev); return; }
        const fn = a.timers.get(ev.id);
        if (!fn) return; // cancelled
        a.timers.delete(ev.id);
        this.fold(TIMER, a.index, ev.id, ev.t);
        this.recorder?.timer(a);
        return this.invoke(a, fn);
      }
      case CALL:
        return ev.fn();
    }
  }

  // Run a piece of actor code with attribution: exceptions become findings,
  // Math.random routes to the actor's own stream, and the recorder snapshots
  // the actor's state afterwards.
  invoke(a, fn) {
    const prev = this.current;
    this.current = a;
    try {
      fn();
    } catch (err) {
      const name = (err && err.name) || 'Error';
      this.fail(`exception:${name}`, `${a.id} threw ${name}: ${err && err.message}`, {
        node: a.id,
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
      });
    } finally {
      this.current = prev;
    }
    if (this.recorder && a.impl) this.recorder.snapshot(a);
  }

  // ── observation ───────────────────────────────────────────────────────────

  emit(a, kind, data) {
    const e = { t: this.now, node: a.id, kind, data };
    this.recorder?.emit(e);
    for (let i = 0; i < this.hooks.length; i++) this.hooks[i](e);
    for (const m of this.monitors) {
      if (!m.onEmit || this.violation) continue;
      const v = m.onEmit(e, this);
      if (v) this.monitorFail(m, v, a.id);
    }
  }

  monitorFail(m, v, node) {
    const rule = typeof v === 'string' ? m.name : v.rule || m.name;
    const message = typeof v === 'string' ? v : v.message;
    this.fail(`invariant:${rule}`, message, { rule, node, monitor: m.name });
  }

  fail(signature, message, details = {}) {
    if (this.violation) return;
    this.violation = { signature, message, time: this.now, ...details };
    this.stopped = true;
    this.recorder?.violation(this.violation);
  }

  // ── faults ────────────────────────────────────────────────────────────────

  crash(id) {
    const a = this.actors.get(id);
    if (!a || !a.alive || a.kind !== 'node') return false;
    a.alive = false;
    a.inc++;
    a.crashes++;
    a.impl = null;
    a.ctx = null;
    a.timers.clear();
    a.paused = false;
    a.deferred = [];
    const crashNo = a.crashes;
    const lost = a.disk.crash(this.diskLoss, (i) => unit(hash6(this.seed, DISK, a.index, crashNo, i, 0)));
    this.fold(0xc4a54, a.index, crashNo, lost);
    this.recorder?.life(a, 'crash', { lostWrites: lost });
    return true;
  }

  restart(id) {
    const a = this.actors.get(id);
    if (!a || a.alive) return false;
    this.boot(a);
    return true;
  }

  pause(id) {
    const a = this.actors.get(id);
    if (!a || !a.alive || a.paused) return false;
    a.paused = true;
    this.recorder?.life(a, 'pause');
    return true;
  }

  resume(id) {
    const a = this.actors.get(id);
    if (!a || !a.paused) return false;
    a.paused = false;
    const backlog = a.deferred;
    a.deferred = [];
    this.recorder?.life(a, 'resume', { backlog: backlog.length });
    for (const ev of backlog) this.schedule(this.now, ev);
    return true;
  }

  setClock(id, rate, jumpMs = 0) {
    const a = this.actors.get(id);
    if (!a) return false;
    a.clock = { base: this.now, local: this.localTime(a) + jumpMs * US, rate };
    this.recorder?.life(a, 'clock', { rate, jump: jumpMs });
    return true;
  }

  partition(cuts) { this.network.setCuts(cuts); }
  heal() { this.network.setCuts([]); }

  // "All faults healed" includes the weather: no more loss, duplication or
  // latency spikes. Liveness is only meaningful on a healthy network.
  calmNetwork() {
    const cfg = this.network.cfg;
    cfg.drop = 0;
    cfg.dup = 0;
    cfg.latency = { ...cfg.latency, tail: 0 };
  }

  get stats() {
    return {
      events: this.events,
      time: this.now,
      sent: this.network.sent,
      delivered: this.network.delivered,
      dropped: this.network.dropped,
    };
  }
}
