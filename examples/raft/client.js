// A Raft client with honest failure semantics.
//
// It follows leader hints and retries on "not leader" (the request was
// definitely not appended). But once a request has gone unanswered, it can
// never say "failed" — the request might still be sitting in some node's log,
// waiting to be committed by a future leader. So timeouts and give-ups are
// reported as "info": outcome unknown. The checker knows how to handle those.

export class RaftClient {
  constructor(ctx, { params = {}, scenario } = {}) {
    this.ctx = ctx;
    this.timeout = params.opTimeout ?? scenario?.workload?.opTimeout ?? 1000;
    this.maxAttempts = 10;
    this.leader = null;
    this.reqSeq = 0;
    this.opSeq = 0;
    this.cur = null;
  }

  invoke(op, done) {
    this.cur = { op, done, opId: ++this.opSeq, attempts: 0, reqId: 0, timer: null };
    this.attempt();
  }

  attempt() {
    const c = this.cur;
    c.attempts++;
    const nodes = this.ctx.nodes;
    const target = this.leader ?? nodes[this.ctx.randomInt(0, nodes.length - 1)];
    c.reqId = ++this.reqSeq;
    this.ctx.send(target, { type: 'ClientRequest', reqId: c.reqId, opId: c.opId, op: c.op });
    c.timer = this.ctx.setTimer(this.timeout, () => {
      this.leader = null;
      this.finish({ type: 'info' });
    });
  }

  finish(res) {
    const c = this.cur;
    if (!c) return;
    this.ctx.cancelTimer(c.timer);
    this.cur = null;
    c.done(res);
  }

  onMessage(from, m) {
    const c = this.cur;
    if (m.type !== 'ClientResponse' || !c || m.reqId !== c.reqId) return;
    this.ctx.cancelTimer(c.timer);
    if (m.notLeader) {
      const others = this.ctx.nodes.filter((n) => n !== from);
      this.leader = m.leader && m.leader !== from ? m.leader : others[this.ctx.randomInt(0, others.length - 1)];
      if (c.attempts >= this.maxAttempts) return this.finish({ type: 'info' });
      c.timer = this.ctx.setTimer(5 * c.attempts, () => this.attempt());
      return;
    }
    if (m.unknown) return this.finish({ type: 'info' });
    this.leader = from;
    this.finish({ type: 'ok', value: m.value });
  }
}
