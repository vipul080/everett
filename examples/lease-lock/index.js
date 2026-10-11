// Lease-based locking — the argument at the heart of "How to do distributed
// locking" (Kleppmann, 2016) and the Redlock debate, made executable.
//
// Workers increment a shared counter with read-modify-write. A lock server
// hands out leases (with monotonically increasing tokens) so only one worker
// is supposed to be in the critical section at a time. Workers even double-
// check their lease on their own clock before writing.
//
// It still isn't safe: a worker can be paused (GC, VM migration, swapping)
// between checking its lease and writing, or its clock can drift. The fix is
// fencing: the storage rejects requests carrying a token older than one it
// has already seen. And — the part people miss — the storage must register
// tokens on *reads* too, or a stale read slips through and an increment is
// still lost.

export const BUGS = {
  'no-fencing':
    'The store ignores lease tokens and trusts that whoever writes holds the lock. A worker that stalls after checking its lease overwrites newer data.',
  'fence-writes-only':
    'The store fences writes but not reads. A stale holder can still read, then write before the new holder does, and an increment is lost.',
};

const LEASE_MS = 100;

class LockServer {
  constructor(ctx) { this.ctx = ctx; }
  onStart() {
    this.holder = null;
    this.expires = 0;
    this.token = 0;
  }
  onMessage(from, m) {
    const now = this.ctx.now();
    if (m.type === 'acquire') {
      if (this.holder === null || now >= this.expires || this.holder === from) {
        this.holder = from;
        this.token++;
        this.expires = now + LEASE_MS;
        this.ctx.send(from, { type: 'granted', reqId: m.reqId, token: this.token, ttl: LEASE_MS });
      } else {
        this.ctx.send(from, { type: 'busy', reqId: m.reqId, retryIn: this.expires - now });
      }
    } else if (m.type === 'release' && this.holder === from && m.token === this.token) {
      this.holder = null;
    }
  }
  inspect() {
    return { role: this.holder ? 'locked' : 'free', holder: this.holder, token: this.token, expires: Math.round(this.expires) };
  }
}

class Store {
  constructor(ctx, bugs) { this.ctx = ctx; this.bugs = bugs; }
  onStart() {
    this.value = 0;
    this.maxToken = 0;
    this.lastWid = new Map();
  }
  stale(token) {
    return !this.bugs.has('no-fencing') && token < this.maxToken;
  }
  onMessage(from, m) {
    if (m.type === 'read') {
      const fenceReads = !this.bugs.has('no-fencing') && !this.bugs.has('fence-writes-only');
      if (fenceReads && this.stale(m.token)) {
        return this.ctx.send(from, { type: 'rejected', reqId: m.reqId, maxToken: this.maxToken });
      }
      if (fenceReads) this.maxToken = Math.max(this.maxToken, m.token);
      this.ctx.send(from, { type: 'value', reqId: m.reqId, value: this.value });
    } else if (m.type === 'write') {
      if ((this.lastWid.get(from) ?? 0) >= m.wid) return; // duplicate delivery
      this.lastWid.set(from, m.wid);
      if (this.stale(m.token)) {
        return this.ctx.send(from, { type: 'rejected', reqId: m.reqId, maxToken: this.maxToken });
      }
      if (!this.bugs.has('no-fencing')) this.maxToken = Math.max(this.maxToken, m.token);
      const prev = this.value;
      this.value = m.value;
      this.ctx.emit('write', { worker: from, token: m.token, prev, value: m.value });
      this.ctx.send(from, { type: 'written', reqId: m.reqId });
    }
  }
  inspect() { return { role: 'store', value: this.value, maxToken: this.maxToken }; }
}

class Worker {
  constructor(ctx) { this.ctx = ctx; }
  onStart() {
    this.state = 'idle';
    this.reqId = 0;
    this.wid = 0;
    this.token = null;
    this.leaseEnd = 0;
    this.value = null;
    this.retry = null;
    this.later(this.ctx.random() * 30, () => this.acquire());
  }
  later(ms, fn) { return this.ctx.setTimer(ms, fn); }

  acquire() {
    this.state = 'acquiring';
    this.token = null;
    const reqId = ++this.reqId;
    this.ctx.send('lock', { type: 'acquire', reqId });
    this.ctx.cancelTimer(this.retry);
    this.retry = this.later(50, () => { if (this.reqId === reqId) this.acquire(); });
  }

  onMessage(from, m) {
    if (m.reqId !== this.reqId) return;
    this.ctx.cancelTimer(this.retry);
    switch (m.type) {
      case 'busy':
        this.state = 'waiting';
        this.retry = this.later(Math.max(2, m.retryIn) + this.ctx.random() * 10, () => this.acquire());
        break;
      case 'granted':
        this.token = m.token;
        this.leaseEnd = this.ctx.now() + m.ttl;
        this.state = 'reading';
        this.ctx.emit('acquired', { token: m.token });
        this.ctx.send('store', { type: 'read', reqId: ++this.reqId, token: m.token });
        this.retry = this.later(50, () => this.acquire());
        break;
      case 'value':
        this.value = m.value;
        this.state = 'working';
        this.ctx.emit('read', { value: m.value, token: this.token });
        this.later(5 + this.ctx.random() * 20, () => this.finishWork());
        break;
      case 'written':
        this.ctx.send('lock', { type: 'release', token: this.token });
        this.state = 'idle';
        this.token = null;
        this.later(this.ctx.random() * 30, () => this.acquire());
        break;
      case 'rejected':
        this.ctx.emit('fenced', { token: this.token, maxToken: m.maxToken });
        this.state = 'idle';
        this.token = null;
        this.later(5 + this.ctx.random() * 20, () => this.acquire());
        break;
    }
  }

  finishWork() {
    if (this.state !== 'working') return;
    // The "careful" check everyone writes: is my lease still valid?
    if (this.ctx.now() >= this.leaseEnd) {
      this.ctx.emit('expired', { token: this.token });
      return this.acquire();
    }
    this.ctx.emit('checked', { token: this.token, left: Math.round(this.leaseEnd - this.ctx.now()) });
    // …and then a moment later, the write goes out. Anything can happen in
    // that moment: a GC pause, a page fault, a slow network.
    this.state = 'writing';
    const reqId = ++this.reqId;
    this.later(1, () => {
      if (this.reqId !== reqId) return;
      this.ctx.send('store', { type: 'write', reqId, token: this.token, value: this.value + 1, wid: ++this.wid });
      this.retry = this.later(80, () => this.acquire());
    });
  }

  inspect() {
    return {
      role: this.state,
      token: this.token,
      leaseLeft: this.token ? Math.round(this.leaseEnd - this.ctx.now()) : null,
      value: this.value,
    };
  }
}

function lostUpdates(scenario) {
  let last = null;
  let progressAfterHeal = false;
  return {
    name: 'counter',
    onEmit(e) {
      if (e.kind !== 'write') return null;
      const d = e.data;
      if (e.t >= scenario.healAt) progressAfterHeal = true;
      if (d.value !== d.prev + 1) {
        let why = 'two workers were inside the critical section at once.';
        if (last && last.worker !== d.worker) {
          why = last.token < d.token
            ? `${last.worker} (token ${last.token}) wrote ${last.value} after its lease had already passed to ${d.worker} — ` +
              `between ${d.worker}'s read and its write. Two workers were inside the critical section at once.`
            : `${d.worker}'s lease had lapsed: ${last.worker} (token ${last.token}) had taken over and written ${last.value}, ` +
              `yet the store accepted the stale holder's write.`;
        }
        return {
          rule: 'lost-update',
          message: `lost update: ${d.worker} (token ${d.token}) wrote ${d.value} over ${d.prev}. ${why}`,
        };
      }
      last = d;
      return null;
    },
    onEnd(world) {
      if (scenario.healAt < scenario.duration - 1_000_000 && !progressAfterHeal) {
        return { rule: 'no-progress', message: 'no increment succeeded in the second after every fault healed' };
      }
      return null;
    },
  };
}

export const system = {
  name: 'lease-lock',
  title: 'Lease lock + fencing',
  summary: 'Workers incrementing a shared counter under a lease-based lock (Kleppmann vs. Redlock).',
  defaults: { duration: 6000, quiesce: 1500, network: { dup: 0 } },
  topology(rng) {
    const workers = rng.range(2, 3);
    return { nodes: ['lock', 'store', ...Array.from({ length: workers }, (_, i) => `w${i + 1}`)], clients: [] };
  },
  faults: ['pause', 'clock', 'partition'],
  targets: {
    pause: (nodes) => nodes.filter((n) => n.startsWith('w')),
    clock: (nodes) => nodes.filter((n) => n !== 'store'),
    crash: () => [],
  },
  triggers: { acquired: 6, read: 6, checked: 6 },
  bugs: BUGS,
  createNode(ctx, { bugs }) {
    if (ctx.id === 'lock') return new LockServer(ctx);
    if (ctx.id === 'store') return new Store(ctx, bugs);
    return new Worker(ctx);
  },
  createClient() { throw new Error('lease-lock has no clients'); },
  monitors: ({ scenario }) => [lostUpdates(scenario)],
  describe(e) {
    switch (e.kind) {
      case 'acquired': return `acquires the lock (token ${e.data.token})`;
      case 'read': return `reads counter = ${e.data.value}`;
      case 'checked': return `checks its lease: ${e.data.left}ms left, safe to write`;
      case 'expired': return 'sees its lease has expired and backs off';
      case 'fenced': return `is fenced off: token ${e.data.token} < ${e.data.maxToken}`;
      case 'write': return `stores ${e.data.value} from ${e.data.worker} (token ${e.data.token})`;
      default: return null;
    }
  },
  messageColors: {
    acquire: 'violet', granted: 'violet', busy: 'violet', release: 'violet',
    read: 'blue', value: 'blue',
    write: 'teal', written: 'teal',
    rejected: 'red',
  },
};
