// The smallest interesting system: a replicated register where every node
// accepts writes, applies them locally, and gossips them to its peers.
// It is fast, simple, always available… and not linearizable.
//
//   everett explore examples/gossip-register
//
// This file is the template for testing your own system with Everett.

import { kvModel, kvGenerator } from '../../src/index.js';

class Replica {
  constructor(ctx) {
    this.ctx = ctx;
    this.data = new Map();
  }

  onMessage(from, m) {
    if (m.type === 'put') {
      this.data.set(m.key, m.value);
      for (const peer of this.ctx.peers) this.ctx.send(peer, { type: 'sync', key: m.key, value: m.value });
      this.ctx.send(from, { type: 'reply', id: m.id, value: true });
    } else if (m.type === 'get') {
      this.ctx.send(from, { type: 'reply', id: m.id, value: this.data.get(m.key) ?? null });
    } else if (m.type === 'sync') {
      this.data.set(m.key, m.value);
    }
  }

  // Optional: what the time-travel debugger shows for this node.
  inspect() {
    return { role: 'replica', kv: Object.fromEntries(this.data) };
  }
}

class Client {
  constructor(ctx) {
    this.ctx = ctx;
    this.seq = 0;
    this.pending = null;
  }

  // Called by the workload with { f, key, value }. Report exactly once:
  // { type: 'ok', value } on success, { type: 'info' } if the outcome is unknown.
  invoke(op, done) {
    const id = ++this.seq;
    const node = this.ctx.nodes[this.ctx.randomInt(0, this.ctx.nodes.length - 1)];
    this.ctx.send(node, { type: op.f, key: op.key, value: op.value, id });
    const timer = this.ctx.setTimer(500, () => { this.pending = null; done({ type: 'info' }); });
    this.pending = { id, done, timer };
  }

  onMessage(from, m) {
    if (!this.pending || m.id !== this.pending.id) return;
    const { done, timer } = this.pending;
    this.ctx.cancelTimer(timer);
    this.pending = null;
    done({ type: 'ok', value: m.value });
  }
}

export const system = {
  name: 'gossip-register',
  title: 'Gossip register',
  summary: 'Every node accepts writes and gossips them. Always available, never linearizable.',
  defaults: { nodes: 3, clients: 3 },
  createNode: (ctx) => new Replica(ctx),
  createClient: (ctx) => new Client(ctx),
  workload: () => kvGenerator({ keys: ['x'], reads: 0.5, cas: 0 }),
  model: kvModel,
  describe: () => null,
};
