// A Raft cluster replicating a key-value store.
//
// This is a straightforward, by-the-paper implementation (Ongaro & Ousterhout,
// "In Search of an Understandable Consensus Algorithm", 2014): leader election
// with randomized timeouts, log replication with fast backtracking, commit
// only of current-term entries, persistence with fsync before every
// acknowledgement, no-op on election, linearizable reads through the log, and
// client sessions for exactly-once application.
//
// Each `bug(...)` check below is a deliberate, switchable mistake — every one
// of them a bug that has shipped in a real consensus implementation.

export const BUGS = {
  'stale-reads':
    'Leader answers reads from local state without confirming it is still leader. A deposed leader on the wrong side of a partition serves stale data.',
  'ack-before-commit':
    'Leader acknowledges writes as soon as they hit its own log, before a majority has them. Acknowledged writes vanish when it is deposed.',
  'forget-vote':
    'votedFor is kept in memory only. A node that crashes and restarts can vote twice in one term, electing two leaders.',
  'vote-any-log':
    'Voters skip the election restriction (candidate log must be at least as up-to-date). A node missing committed entries can win and erase them.',
  'truncate-on-match':
    'Followers truncate their log after prevLogIndex even when entries match. A delayed, stale AppendEntries silently deletes acknowledged entries.',
  'lazy-fsync':
    'Log appends are acknowledged before fsync; the disk is flushed on a timer instead ("group commit"). A crash loses entries the leader counted as replicated.',
  'figure-8':
    'Leader commits entries from earlier terms by counting replicas, without first committing an entry of its own term — Figure 8 of the Raft paper. A "committed" entry can be overwritten.',
};

const NOOP = 'noop';

export class RaftNode {
  constructor(ctx, { bugs = new Set(), params = {} } = {}) {
    this.ctx = ctx;
    this.bugs = bugs;
    this.cfg = {
      electionMin: 150,
      electionMax: 300,
      heartbeat: 50,
      batch: 64,
      ...(params.raft || {}),
    };
  }

  bug(name) { return this.bugs.has(name); }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  onStart() {
    const d = this.ctx.disk;
    this.currentTerm = d.get('term') ?? 0;
    this.votedFor = d.get('vote') ?? null;
    this.log = [{ term: 0, cmd: { f: NOOP, id: 'genesis' } }];
    const len = d.get('len') ?? 0;
    for (let i = 1; i <= len; i++) {
      const e = d.get('log/' + i);
      if (!e) break; // torn tail after a crash: everything past here was never acknowledged
      this.log.push(e);
    }
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.kv = new Map();
    this.sessions = new Map(); // client -> { opId, result }
    this.role = 'follower';
    this.leaderId = null;
    this.votes = null;
    this.nextIndex = null;
    this.matchIndex = null;
    this.pending = new Map(); // log index -> { client, reqId, term }
    this.electionTimer = null;
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.resetElectionTimer();
    if (this.bug('lazy-fsync')) this.scheduleFlush();
  }

  get lastIndex() { return this.log.length - 1; }
  get lastTerm() { return this.log[this.log.length - 1].term; }
  get majority() { return Math.floor(this.ctx.nodes.length / 2) + 1; }

  // ── persistence ────────────────────────────────────────────────────────────

  setTerm(term) {
    this.currentTerm = term;
    this.votedFor = null;
    this.ctx.disk.set('term', term);
    this.ctx.disk.set('vote', null);
    this.ctx.disk.fsync();
  }

  setVote(id) {
    this.votedFor = id;
    if (this.bug('forget-vote')) return;
    this.ctx.disk.set('vote', id);
    this.ctx.disk.fsync();
  }

  truncateFrom(index) {
    this.ctx.emit('truncate', { from: index, last: this.lastIndex, commit: this.commitIndex });
    this.log.length = index;
    this.ctx.disk.set('len', index - 1);
  }

  appendToLog(entries) {
    const d = this.ctx.disk;
    for (const e of entries) {
      this.log.push(e);
      d.set('log/' + this.lastIndex, e);
    }
    d.set('len', this.lastIndex);
  }

  syncLog() {
    if (!this.bug('lazy-fsync')) this.ctx.disk.fsync();
  }

  scheduleFlush() {
    this.flushTimer = this.ctx.setTimer(100, () => {
      this.ctx.disk.fsync();
      this.scheduleFlush();
    });
  }

  // ── timers & roles ─────────────────────────────────────────────────────────

  resetElectionTimer() {
    this.ctx.cancelTimer(this.electionTimer);
    const { electionMin: lo, electionMax: hi } = this.cfg;
    this.electionTimer = this.ctx.setTimer(lo + this.ctx.random() * (hi - lo), () => {
      this.electionTimer = null;
      if (this.role !== 'leader') this.startElection();
    });
  }

  becomeFollower(term, resetTimer) {
    const wasLeader = this.role === 'leader';
    if (term > this.currentTerm) this.setTerm(term);
    if (wasLeader) {
      this.ctx.emit('stepdown', { term: this.currentTerm });
      this.ctx.cancelTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.abandonPending();
    }
    const changed = this.role !== 'follower';
    this.role = 'follower';
    this.votes = null;
    if (resetTimer || changed) this.resetElectionTimer();
  }

  startElection() {
    this.setTerm(this.currentTerm + 1);
    this.setVote(this.ctx.id);
    this.role = 'candidate';
    this.leaderId = null;
    this.votes = new Set([this.ctx.id]);
    this.ctx.emit('candidate', { term: this.currentTerm });
    this.resetElectionTimer();
    if (this.votes.size >= this.majority) return this.becomeLeader();
    this.requestVotes(this.currentTerm);
  }

  // Ask every peer that has not voted for us yet; repeat until the election
  // resolves. RPCs get lost — a candidate that asks only once rarely wins.
  requestVotes(term) {
    if (this.role !== 'candidate' || this.currentTerm !== term) return;
    for (const p of this.ctx.peers) {
      if (this.votes.has(p)) continue;
      this.ctx.send(p, {
        type: 'RequestVote',
        term,
        lastLogIndex: this.lastIndex,
        lastLogTerm: this.lastTerm,
      });
    }
    this.ctx.setTimer(this.cfg.heartbeat, () => this.requestVotes(term));
  }

  becomeLeader() {
    this.role = 'leader';
    this.leaderId = this.ctx.id;
    this.ctx.cancelTimer(this.electionTimer);
    this.electionTimer = null;
    this.nextIndex = {};
    this.matchIndex = {};
    for (const p of this.ctx.peers) {
      this.nextIndex[p] = this.lastIndex + 1;
      this.matchIndex[p] = 0;
    }
    this.ctx.emit('leader', { term: this.currentTerm });
    // A no-op in the new term lets the leader commit everything it inherited.
    // (Implementations with the figure-8 bug typically skip it — that is
    // precisely what lets the bug bite.)
    if (!this.bug('figure-8')) {
      this.appendToLog([{ term: this.currentTerm, cmd: { f: NOOP, id: `noop:${this.currentTerm}` } }]);
      this.syncLog();
    }
    this.broadcast();
    this.advanceCommit();
    this.scheduleHeartbeat();
  }

  scheduleHeartbeat() {
    this.heartbeatTimer = this.ctx.setTimer(this.cfg.heartbeat, () => {
      this.heartbeatTimer = null;
      if (this.role !== 'leader') return;
      this.broadcast();
      this.scheduleHeartbeat();
    });
  }

  abandonPending() {
    // We can no longer tell these clients what happened: the entries may yet
    // be committed by a future leader. "Unknown" is the only honest answer.
    for (const p of this.pending.values()) {
      this.ctx.send(p.client, { type: 'ClientResponse', reqId: p.reqId, unknown: true });
    }
    this.pending.clear();
  }

  // ── messages ───────────────────────────────────────────────────────────────

  onMessage(from, m) {
    switch (m.type) {
      case 'RequestVote': return this.onRequestVote(from, m);
      case 'RequestVoteReply': return this.onRequestVoteReply(from, m);
      case 'AppendEntries': return this.onAppendEntries(from, m);
      case 'AppendEntriesReply': return this.onAppendEntriesReply(from, m);
      case 'ClientRequest': return this.onClientRequest(from, m);
    }
  }

  onRequestVote(from, m) {
    if (m.term > this.currentTerm) this.becomeFollower(m.term, false);
    let granted = false;
    if (m.term === this.currentTerm && (this.votedFor === null || this.votedFor === from)) {
      const upToDate =
        m.lastLogTerm > this.lastTerm ||
        (m.lastLogTerm === this.lastTerm && m.lastLogIndex >= this.lastIndex);
      if (upToDate || this.bug('vote-any-log')) {
        granted = true;
        if (this.votedFor !== from) {
          this.setVote(from);
          this.ctx.emit('vote', { term: this.currentTerm, for: from });
        }
        this.resetElectionTimer();
      }
    }
    this.ctx.send(from, { type: 'RequestVoteReply', term: this.currentTerm, granted });
  }

  onRequestVoteReply(from, m) {
    if (m.term > this.currentTerm) return this.becomeFollower(m.term, true);
    if (this.role !== 'candidate' || m.term !== this.currentTerm || !m.granted) return;
    this.votes.add(from);
    if (this.votes.size >= this.majority) this.becomeLeader();
  }

  sendAppendEntries(peer) {
    const next = this.nextIndex[peer];
    const prev = next - 1;
    this.ctx.send(peer, {
      type: 'AppendEntries',
      term: this.currentTerm,
      prevLogIndex: prev,
      prevLogTerm: this.log[prev].term,
      entries: this.log.slice(next, next + this.cfg.batch),
      leaderCommit: this.commitIndex,
    });
  }

  broadcast() {
    for (const p of this.ctx.peers) this.sendAppendEntries(p);
  }

  onAppendEntries(from, m) {
    const reply = (success, extra) =>
      this.ctx.send(from, { type: 'AppendEntriesReply', term: this.currentTerm, success, ...extra });

    if (m.term < this.currentTerm) return reply(false, { conflictIndex: 0, stale: true });
    if (m.term > this.currentTerm || this.role !== 'follower') this.becomeFollower(m.term, false);
    this.leaderId = from;
    this.resetElectionTimer();

    if (m.prevLogIndex > this.lastIndex) {
      return reply(false, { conflictIndex: this.lastIndex + 1 });
    }
    if (this.log[m.prevLogIndex].term !== m.prevLogTerm) {
      const t = this.log[m.prevLogIndex].term;
      let i = m.prevLogIndex;
      while (i > 1 && this.log[i - 1].term === t) i--;
      return reply(false, { conflictIndex: i });
    }

    let changed = false;
    if (this.bug('truncate-on-match')) {
      if (m.prevLogIndex + 1 <= this.lastIndex) this.truncateFrom(m.prevLogIndex + 1);
      if (m.entries.length) this.appendToLog(m.entries);
      changed = true;
    } else {
      for (let j = 0; j < m.entries.length; j++) {
        const idx = m.prevLogIndex + 1 + j;
        if (idx <= this.lastIndex) {
          if (this.log[idx].term === m.entries[j].term) continue;
          this.truncateFrom(idx);
        }
        this.appendToLog(m.entries.slice(j));
        changed = true;
        break;
      }
    }
    if (changed) this.syncLog();

    const lastNew = m.prevLogIndex + m.entries.length;
    const newCommit = Math.min(m.leaderCommit, lastNew);
    if (newCommit > this.commitIndex) {
      this.commitIndex = newCommit;
      this.apply();
    }
    reply(true, { matchIndex: lastNew });
  }

  onAppendEntriesReply(from, m) {
    if (m.term > this.currentTerm) return this.becomeFollower(m.term, true);
    if (this.role !== 'leader' || m.term !== this.currentTerm) return;
    if (m.success) {
      if (m.matchIndex > this.matchIndex[from]) this.matchIndex[from] = m.matchIndex;
      this.nextIndex[from] = Math.max(this.nextIndex[from], this.matchIndex[from] + 1);
      this.advanceCommit();
    } else {
      const floor = this.matchIndex[from] + 1;
      const next = Math.max(floor, 1, Math.min(this.nextIndex[from] - 1, m.conflictIndex));
      // Retry at once only if we learned something; otherwise wait for the
      // next heartbeat rather than ping-ponging the same rejection forever.
      if (next !== this.nextIndex[from]) {
        this.nextIndex[from] = next;
        this.sendAppendEntries(from);
      }
    }
  }

  advanceCommit() {
    for (let n = this.lastIndex; n > this.commitIndex; n--) {
      // Raft §5.4.2: only entries from the leader's current term are committed
      // by counting replicas. Older entries are committed indirectly.
      if (this.log[n].term !== this.currentTerm && !this.bug('figure-8')) break;
      let count = 1;
      for (const p of this.ctx.peers) if (this.matchIndex[p] >= n) count++;
      if (count >= this.majority) {
        this.commitIndex = n;
        this.apply();
        return;
      }
    }
  }

  apply() {
    while (this.lastApplied < this.commitIndex && this.lastApplied < this.lastIndex) {
      const index = ++this.lastApplied;
      const e = this.log[index];
      const result = this.execute(e.cmd);
      this.ctx.emit('apply', { index, term: e.term, id: e.cmd.id });
      const p = this.pending.get(index);
      if (p) {
        this.pending.delete(index);
        if (p.term === e.term && p.id === e.cmd.id) {
          this.ctx.send(p.client, { type: 'ClientResponse', reqId: p.reqId, ok: true, value: result });
        } else {
          this.ctx.send(p.client, { type: 'ClientResponse', reqId: p.reqId, unknown: true });
        }
      }
    }
  }

  execute(cmd) {
    if (cmd.f === NOOP) return null;
    // Sessions: a command a client already applied is not applied again.
    const s = this.sessions.get(cmd.client);
    if (s && cmd.opId <= s.opId) return cmd.opId === s.opId ? s.result : null;
    let result = null;
    const cur = this.kv.has(cmd.key) ? this.kv.get(cmd.key) : null;
    switch (cmd.f) {
      case 'get': result = cur; break;
      case 'put': this.kv.set(cmd.key, cmd.value); result = true; break;
      case 'cas':
        if (cur === cmd.value[0]) { this.kv.set(cmd.key, cmd.value[1]); result = true; } else result = false;
        break;
    }
    this.sessions.set(cmd.client, { opId: cmd.opId, result });
    return result;
  }

  onClientRequest(from, m) {
    if (this.role !== 'leader') {
      return this.ctx.send(from, { type: 'ClientResponse', reqId: m.reqId, notLeader: true, leader: this.leaderId });
    }
    const op = m.op;
    if (op.f === 'get' && this.bug('stale-reads')) {
      const v = this.kv.has(op.key) ? this.kv.get(op.key) : null;
      return this.ctx.send(from, { type: 'ClientResponse', reqId: m.reqId, ok: true, value: v });
    }
    const cmd = { ...op, client: from, opId: m.opId, id: `${from}:${m.opId}` };
    this.appendToLog([{ term: this.currentTerm, cmd }]);
    this.syncLog();
    if (op.f === 'put' && this.bug('ack-before-commit')) {
      this.ctx.send(from, { type: 'ClientResponse', reqId: m.reqId, ok: true, value: true });
    } else {
      this.pending.set(this.lastIndex, { client: from, reqId: m.reqId, term: this.currentTerm, id: cmd.id });
    }
    this.broadcast();
    this.advanceCommit();
  }

  // What the time-travel debugger shows for this node.
  inspect() {
    return {
      role: this.role,
      term: this.currentTerm,
      votedFor: this.votedFor,
      leader: this.leaderId,
      commit: this.commitIndex,
      applied: this.lastApplied,
      log: this.log.slice(1).map((e) => [e.term, e.cmd.f === NOOP ? '·' : summarize(e.cmd)]),
      kv: Object.fromEntries(this.kv),
    };
  }
}

function summarize(cmd) {
  if (cmd.f === 'put') return `${cmd.key}=${cmd.value}`;
  if (cmd.f === 'get') return `${cmd.key}?`;
  if (cmd.f === 'cas') return `${cmd.key}:${cmd.value[0]}→${cmd.value[1]}`;
  return cmd.f;
}
