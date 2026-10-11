// Narration: turn a recorded universe into a story a human can read in ten
// seconds. Faults, elections, the operations that matter, and the violation.

import { components } from './util.js';

export function describeEvent(system, e) {
  const text = system.describe ? system.describe(e) : null;
  return text ? `${e.node} ${text}` : `${e.node} ${e.kind}`;
}

export function describeFault(f, nodes, system) {
  const why = f.trigger ? ` — the instant after ${describeEvent(system || {}, f.trigger)}` : '';
  switch (f.type) {
    case 'partition': {
      if (f.kind === 'oneway') {
        const mute = f.cuts[0][0];
        return `network fault: ${mute} goes mute — it hears everyone, nobody hears it${why}`;
      }
      const groups = components(nodes, f.cuts);
      if (groups.length > 1) {
        return `network partition (${f.kind}): ${groups.map((g) => `{${g.join(' ')}}`).join(' ⟂ ')}${why}`;
      }
      if (f.kind === 'bridge') {
        const counts = new Map(nodes.map((n) => [n, 0]));
        for (const [a] of f.cuts) counts.set(a, counts.get(a) + 1);
        const bridge = nodes.find((n) => counts.get(n) === 0);
        return `bridge partition: only ${bridge} can see both sides${why}`;
      }
      return `${f.kind} partition: ${f.cuts.length / 2} links severed, every node sees only its neighbours${why}`;
    }
    case 'heal': return 'network heals';
    case 'crash': return `${f.node} crashes${why}`;
    case 'restart': return `${f.node} restarts, recovering from its disk`;
    case 'pause': return `${f.node} freezes (stop-the-world pause)${why}`;
    case 'resume': return `${f.node} wakes up, unaware that time has passed`;
    case 'clock':
      if (f.rate === 1) return `${f.node}'s clock is corrected`;
      return `${f.node}'s clock starts running ${f.rate}× ${f.rate > 1 ? 'fast' : 'slow'}` +
        (f.jump ? ` and jumps ${f.jump > 0 ? '+' : ''}${f.jump}ms` : '');
    case 'heal-all': return 'all faults heal: network restored, frozen nodes resume, crashed nodes restart';
  }
  return f.type;
}

// Returns [{ t, kind, text, node?, op? }], sorted by time.
export function narrate(system, trace, { maxLines = 40 } = {}) {
  const lines = [];
  const nodes = trace.nodes;
  for (const f of trace.faults) {
    lines.push({ t: f.t, kind: 'fault', text: describeFault(f, nodes, system), fault: f, prio: 3 });
  }
  for (const e of trace.emits) {
    const text = system.describe ? system.describe(e) : null;
    if (!text) continue;
    const prio = e.kind === 'vote' || e.kind === 'candidate' ? 0 : 2;
    lines.push({ t: e.t, kind: 'event', node: e.node, text: `${e.node} ${text}`, prio });
  }
  const v = trace.violation;
  if (v && v.involved && system.model) {
    const involved = new Set(v.involved);
    const culpritOp = trace.history.find((o) => o.id === v.culprit);
    // Writes that matter: the last few acknowledged before the culprit began.
    const writes = trace.history.filter((o) => involved.has(o.id) && o.type === 'ok' && o.f !== 'get' &&
      (o.f !== 'cas' || o.output === true) && (!culpritOp || o.complete <= culpritOp.complete));
    writes.sort((a, b) => a.complete - b.complete);
    const keep = new Set(writes.slice(-3).map((o) => o.id));
    if (culpritOp) keep.add(culpritOp.id);
    for (const op of trace.history) {
      if (!keep.has(op.id)) continue;
      const culprit = op.id === v.culprit;
      lines.push({
        t: op.complete,
        kind: culprit ? 'culprit' : 'op',
        op: op.id,
        text: `${op.client} ${system.model.describe(op)}` + (culprit ? '   ← impossible' : ''),
        prio: culprit ? 4 : 1,
      });
    }
  }
  if (v) lines.push({ t: v.time, kind: 'violation', text: v.message, prio: 5 });
  lines.sort((a, b) => a.t - b.t || a.prio - b.prio);

  // Too long? Drop the least important lines first, but keep the ending.
  let out = lines;
  for (let p = 0; out.length > maxLines && p <= 2; p++) {
    const cutoff = out.length > maxLines ? out[Math.max(0, out.length - 12)].t : Infinity;
    out = out.filter((l) => l.prio > p || l.t >= cutoff);
  }
  if (out.length > maxLines) out = out.slice(out.length - maxLines);
  return out;
}
