// The Raft key-value store, packaged as an Everett system.

import { RaftNode, BUGS } from './raft.js';
import { RaftClient } from './client.js';
import { raftSafety } from './monitor.js';
import { kvModel } from '../../src/checker/models.js';
import { kvGenerator } from '../../src/workload.js';

export const system = {
  name: 'raft',
  title: 'Raft KV store',
  summary: 'A 3- or 5-node Raft cluster replicating a linearizable key-value store.',
  defaults: {
    nodes: [3, 5],
    clients: [2, 4],
    duration: 8000,
    quiesce: 3000,
    liveness: 2500,
    opTimeout: 1000,
  },
  faults: ['partition', 'crash', 'pause', 'clock'],
  // Events the nemesis may strike right after: "crash n2 just after it votes".
  triggers: { vote: 4, leader: 4, candidate: 6, apply: 60 },
  bugs: BUGS,
  createNode: (ctx, opts) => new RaftNode(ctx, opts),
  createClient: (ctx, opts) => new RaftClient(ctx, opts),
  workload: (w) => kvGenerator(w),
  model: kvModel,
  monitors: () => [raftSafety()],

  // One-line narration of the events that matter, for the story view.
  describe(e) {
    switch (e.kind) {
      case 'leader': return `becomes leader of term ${e.data.term}`;
      case 'vote': return `votes for ${e.data.for} in term ${e.data.term}`;
      case 'stepdown': return `steps down (term ${e.data.term})`;
      case 'truncate': return `truncates its log from index ${e.data.from}`;
      default: return null;
    }
  },

  // Colours for message types in the debugger.
  messageColors: {
    RequestVote: 'violet',
    RequestVoteReply: 'violet',
    AppendEntries: 'blue',
    AppendEntriesReply: 'teal',
    ClientRequest: 'orange',
    ClientResponse: 'orange',
  },
};

