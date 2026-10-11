// The Recorder watches a World without touching it: it never draws randomness
// and never schedules events, so a recorded run is the same universe as an
// unrecorded one. Its output is the trace the time-travel debugger renders.

import { clone } from './util.js';

export class Recorder {
  constructor({ snapshots = true } = {}) {
    this.wantSnapshots = snapshots;
    this.messages = [];
    this.byId = new Map();
    this.emits = [];
    this.logs = [];
    this.lifeEvents = [];
    this.faults = [];
    this.snapshots = [];
    this.lastSnap = new Map();
    this.timers = 0;
    this.violationEvent = null;
  }

  attach(world) { this.world = world; }
  get now() { return this.world.now; }

  send(id, from, to, payload, dupOf) {
    const m = {
      id, from: from.id, to: to.id,
      sent: this.now, recv: null, drop: null,
      type: payload && typeof payload === 'object' && payload.type ? String(payload.type) : typeof payload,
      payload,
    };
    if (dupOf) m.dupOf = dupOf;
    this.messages.push(m);
    this.byId.set(id, m);
  }

  drop(id, reason) {
    const m = this.byId.get(id);
    if (m) { m.drop = reason; m.recv = this.now; }
  }

  deliver(id) {
    const m = this.byId.get(id);
    if (m) m.recv = this.now;
  }

  timer() { this.timers++; }

  life(a, what, extra) {
    this.lifeEvents.push({ t: this.now, node: a.id, what, ...(extra || {}) });
  }

  fault(f) { this.faults.push({ t: this.now, ...clone(f) }); }

  emit(e) { this.emits.push({ t: e.t, node: e.node, kind: e.kind, data: clone(e.data) }); }

  log(a, args) {
    const text = args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    this.logs.push({ t: this.now, node: a.id, text });
  }

  snapshot(a) {
    if (!this.wantSnapshots || typeof a.impl.inspect !== 'function') return;
    const state = a.impl.inspect();
    const json = JSON.stringify(state);
    if (json === this.lastSnap.get(a.id)) return;
    this.lastSnap.set(a.id, json);
    this.snapshots.push({ t: this.now, node: a.id, state: JSON.parse(json) });
  }

  violation(v) { this.violationEvent = { ...v }; }

  toJSON() {
    const w = this.world;
    return {
      nodes: [...w.nodeIds],
      clients: [...w.clientIds],
      end: w.now,
      messages: this.messages.map((m) => ({ ...m, recv: m.recv })),
      emits: this.emits,
      logs: this.logs,
      life: this.lifeEvents,
      faults: this.faults,
      snapshots: this.snapshots,
      timers: this.timers,
    };
  }
}
