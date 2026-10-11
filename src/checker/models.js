// Sequential specifications for the linearizability checker.
//
// A model is { init, step(state, op) -> [ok, nextState], hash, partition,
// readOnly, describe, explain }. step() receives the *completed* operation, so
// it can check observed outputs against what the sequential object would say.

import { deepEqual, fmtTime } from '../util.js';

const show = (v) => (v === null || v === undefined ? 'nil' : JSON.stringify(v));

// A map of independent read/write/compare-and-set registers.
export const kvModel = {
  name: 'kv-register',
  partition: (op) => op.key,
  readOnly: (op) => op.f === 'get',
  init: () => null,
  hash: (s) => (s === null ? '∅' : JSON.stringify(s)),

  step(state, op) {
    switch (op.f) {
      case 'get':
        return [op.type !== 'ok' || deepEqual(op.output ?? null, state), state];
      case 'put':
        return [true, op.value];
      case 'cas': {
        const [from, to] = op.value;
        if (op.type === 'ok') {
          return op.output === true ? [deepEqual(state, from), to] : [!deepEqual(state, from), state];
        }
        return [true, deepEqual(state, from) ? to : state];
      }
      default:
        throw new Error(`kv model: unknown op ${op.f}`);
    }
  },

  describe(op) {
    const res = op.type === 'ok' ? '' : op.type === 'info' ? ' ?' : ' ✗';
    switch (op.f) {
      case 'get': return `get ${op.key}` + (op.type === 'ok' ? ` → ${show(op.output)}` : res);
      case 'put': return `put ${op.key}=${show(op.value)}${res}`;
      case 'cas': return `cas ${op.key} ${show(op.value[0])}→${show(op.value[1])}` +
        (op.type === 'ok' ? (op.output ? ' ✓' : ' ✗') : res);
    }
    return `${op.f} ${op.key}`;
  },

  // Turn "no valid linearization" into a sentence a human can act on.
  explain(result) {
    const { culprit: c, ops, key } = result;
    if (!c) return `no valid ordering of operations on key "${key}"`;
    const who = `${c.client} ${kvModel.describe(c)}`;
    const writes = ops.filter((o) =>
      o.type === 'ok' && (o.f === 'put' || (o.f === 'cas' && o.output === true)));
    const wrote = (o) => (o.f === 'put' ? o.value : o.value[1]);
    if (c.f === 'get' && c.type === 'ok') {
      const v = c.output ?? null;
      if (v === null) {
        const w = writes.find((o) => o.complete < c.invoke);
        if (w) return `${who} at ${fmtTime(c.complete)} — but ${w.client} had already written ${show(wrote(w))} ` +
          `(acknowledged at ${fmtTime(w.complete)}). An acknowledged write vanished.`;
      }
      const src = ops.find((o) => (o.f === 'put' && deepEqual(o.value, v)) || (o.f === 'cas' && deepEqual(o.value[1], v)));
      if (!src && v !== null) return `${who} — but no operation ever wrote ${show(v)}. A phantom value.`;
      if (src) {
        const newer = writes.find((o) => o !== src && src.complete !== null && o.invoke > src.complete && o.complete < c.invoke);
        if (newer) {
          return `${who} at ${fmtTime(c.complete)} — a stale read: ${newer.client} overwrote it with ` +
            `${show(wrote(newer))}, acknowledged at ${fmtTime(newer.complete)}, before this read even began.`;
        }
      }
      return `${who} — no ordering of the concurrent writes can produce that value at that moment.`;
    }
    if (c.f === 'cas' && c.type === 'ok') {
      return c.output
        ? `${who} — but the register never held ${show(c.value[0])} at any moment inside this operation's window.`
        : `${who} — but the register held ${show(c.value[0])} throughout this operation's window, so the CAS should have succeeded.`;
    }
    return `${who} cannot be placed anywhere in its window consistently with the other operations.`;
  },
};

export const models = { kv: kvModel };
