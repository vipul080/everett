// Linearizability checking — Wing & Gong's search with Lowe's memoization,
// the same algorithm behind Porcupine and Knossos.
//
// A history is linearizable if every operation can be assigned a single
// instant, between its invocation and its completion, such that replaying the
// operations in that order through a sequential model reproduces every
// observed output. Operations with unknown outcomes ("info") get an infinite
// completion time: they may take effect at any point after they began, or
// never. Histories are split per key first (P-compositionality), which turns
// an exponential search into many small ones.

export function checkLinearizable(ops, model, { budget = 5_000_000 } = {}) {
  const parts = new Map();
  for (const op of ops) {
    if (op.type === 'fail') continue; // definitely did not happen
    if (op.type === 'info' && model.readOnly(op)) continue; // no effect, no output
    const k = model.partition(op);
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(op);
  }
  let steps = 0;
  let unknown = false;
  for (const [key, list] of parts) {
    const r = checkPartition(list, model, budget - steps);
    steps += r.steps;
    if (r.unknown) { unknown = true; continue; }
    if (!r.ok) return { ok: false, key, steps, ...r };
  }
  return { ok: true, unknown, steps };
}

const CALL = 0, RET = 1;

function checkPartition(ops, model, budget) {
  const n = ops.length;
  const calls = new Array(n);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    const ret = op.type === 'ok' ? op.complete : Infinity;
    const c = { kind: CALL, time: op.invoke, i, op, prev: null, next: null, match: null };
    const r = { kind: RET, time: ret, i, op, prev: null, next: null, match: null };
    c.match = r;
    calls[i] = c;
    entries.push(c, r);
  }
  // At equal timestamps calls sort before returns, so touching operations
  // count as concurrent — the conservative reading.
  entries.sort((a, b) => (a.time - b.time) || (a.kind - b.kind) || (a.i - b.i));

  const head = { prev: null, next: null };
  let prev = head;
  for (const e of entries) { e.prev = prev; prev.next = e; prev = e; }

  const lift = (e) => {
    e.prev.next = e.next;
    e.next.prev = e.prev;
    const m = e.match;
    m.prev.next = m.next;
    if (m.next) m.next.prev = m.prev;
  };
  const unlift = (e) => {
    const m = e.match;
    m.prev.next = m;
    if (m.next) m.next.prev = m;
    e.prev.next = e;
    e.next.prev = e;
  };

  const words = Math.max(1, Math.ceil(n / 32));
  const bits = new Uint32Array(words);
  const flip = (i) => { bits[i >>> 5] ^= 1 << (i & 31); };
  const bitsKey = () => {
    let s = '';
    for (let w = 0; w < words; w++) s += bits[w].toString(36) + ',';
    return s;
  };

  const cache = new Set();
  const stack = [];
  let state = model.init();
  let entry = head.next;
  let steps = 0;
  let best = { depth: -1, op: null, order: [] };

  while (head.next !== null) {
    if (++steps > budget) return { ok: true, unknown: true, steps };
    if (entry.kind === CALL) {
      const [ok, next] = model.step(state, entry.op);
      if (ok) {
        flip(entry.i);
        const key = bitsKey() + model.hash(next);
        if (!cache.has(key)) {
          cache.add(key);
          stack.push(entry, state);
          state = next;
          lift(entry);
          entry = head.next;
          continue;
        }
        flip(entry.i);
      }
      entry = entry.next;
    } else {
      // We reached the completion of an operation we could not place before
      // it: this branch is dead. Remember the deepest dead end — the op stuck
      // there is the best explanation of what went wrong.
      const depth = stack.length >> 1;
      if (depth > best.depth) {
        const order = [];
        for (let s = 0; s < stack.length; s += 2) order.push(stack[s].op.id);
        best = { depth, op: entry.op, order };
      }
      if (stack.length === 0) {
        return { ok: false, steps, culprit: best.op, linearized: best.order, ops };
      }
      const s = stack.pop();
      const e = stack.pop();
      state = s;
      flip(e.i);
      unlift(e);
      entry = e.next;
    }
  }
  return { ok: true, steps };
}
