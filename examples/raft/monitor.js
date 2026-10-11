// Raft's safety properties (Figure 3 of the paper), checked live.
//
// Monitors see the stream of events nodes emit and keep their own god's-eye
// memory of the universe — something no real node could ever have.

export function raftSafety() {
  const leaders = new Map(); // term -> node
  const applied = new Map(); // index -> { id, term, node }
  return {
    name: 'raft-safety',
    onEmit(e) {
      if (e.kind === 'leader') {
        const prev = leaders.get(e.data.term);
        if (prev && prev !== e.node) {
          return {
            rule: 'election-safety',
            message: `Election Safety violated: ${prev} and ${e.node} were both elected leader of term ${e.data.term}`,
          };
        }
        leaders.set(e.data.term, e.node);
      } else if (e.kind === 'apply') {
        const prev = applied.get(e.data.index);
        if (!prev) applied.set(e.data.index, { ...e.data, node: e.node });
        else if (prev.id !== e.data.id || prev.term !== e.data.term) {
          return {
            rule: 'state-machine-safety',
            message: `State Machine Safety violated: at log index ${e.data.index}, ${prev.node} applied ` +
              `${prev.id} (term ${prev.term}) but ${e.node} applied ${e.data.id} (term ${e.data.term})`,
          };
        }
      } else if (e.kind === 'truncate' && e.data.from <= e.data.commit) {
        return {
          rule: 'leader-completeness',
          message: `${e.node} discarded committed entries: truncated its log from index ${e.data.from} ` +
            `although index ${e.data.commit} was already committed`,
        };
      }
      return null;
    },
  };
}
