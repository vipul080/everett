// A simulated disk with honest fsync semantics.
//
// Writes land in a volatile page cache. fsync() makes them durable. A crash
// throws away whatever was not synced — either all of it, or (in 'some' mode)
// a random subset, because real kernels flush dirty pages in whatever order
// they like. Code that acknowledges before it fsyncs will eventually lose data
// here, exactly as it would in production.

import { clone } from './util.js';

const TOMBSTONE = Symbol('deleted');

export class Disk {
  constructor() {
    this.durable = new Map();
    this.cache = new Map();
    this.writes = 0;
    this.syncs = 0;
  }

  get(key) {
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      return v === TOMBSTONE ? undefined : clone(v);
    }
    return clone(this.durable.get(key));
  }

  has(key) {
    if (this.cache.has(key)) return this.cache.get(key) !== TOMBSTONE;
    return this.durable.has(key);
  }

  set(key, value) {
    this.writes++;
    this.cache.set(key, clone(value));
  }

  delete(key) {
    this.writes++;
    this.cache.set(key, TOMBSTONE);
  }

  fsync() {
    this.syncs++;
    for (const [k, v] of this.cache) {
      if (v === TOMBSTONE) this.durable.delete(k);
      else this.durable.set(k, v);
    }
    this.cache.clear();
  }

  get dirty() { return this.cache.size; }

  // mode: 'all' loses every unsynced write; 'some' keeps each with p=0.5.
  // rand(i) supplies deterministic coin flips.
  crash(mode, rand) {
    let lost = 0, i = 0;
    for (const [k, v] of this.cache) {
      const keep = mode === 'some' && rand(i++) < 0.5;
      if (keep) {
        if (v === TOMBSTONE) this.durable.delete(k);
        else this.durable.set(k, v);
      } else lost++;
    }
    this.cache.clear();
    return lost;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.durable) out[k] = v;
    return out;
  }
}
