// Small shared helpers.

export const US_PER_MS = 1000;
export const ms = (x) => Math.round(x * US_PER_MS);

// Deep copy for message payloads and disk values. Nodes must never share
// mutable objects: aliasing between "the network" and "a node's memory" is a
// classic way for simulators to hide real bugs. This is several times faster
// than structuredClone for the small plain objects protocols exchange.
export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = clone(v[i]);
    return out;
  }
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]));
  if (v instanceof Set) return new Set([...v].map(clone));
  const out = {};
  for (const k in v) out[k] = clone(v[k]);
  return out;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

export function fmtTime(us) {
  if (us === null || us === undefined) return '∞';
  if (!Number.isFinite(us)) return '∞';
  return (us / 1e6).toFixed(3) + 's';
}

export function fmtMs(us) {
  const v = us / 1000;
  return v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`;
}

export function hex32(x) {
  return (x >>> 0).toString(16).padStart(8, '0');
}

// Connected components of the "can talk" graph, given a list of directed cuts.
// Used to describe partitions in human terms: {n1,n2} ⟂ {n3,n4,n5}.
export function components(nodes, cuts) {
  const blocked = new Set(cuts.map(([a, b]) => a + '>' + b));
  const seen = new Set();
  const groups = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const group = [];
    const stack = [n];
    seen.add(n);
    while (stack.length) {
      const x = stack.pop();
      group.push(x);
      for (const y of nodes) {
        if (seen.has(y)) continue;
        // Two nodes are grouped only if they can talk in both directions.
        if (!blocked.has(x + '>' + y) && !blocked.has(y + '>' + x)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    groups.push(group.sort());
  }
  return groups;
}
