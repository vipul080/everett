// Deterministic randomness.
//
// Two flavours live here:
//   * Rng — a fast sequential stream (sfc32) that can be forked by label.
//   * hash32/unit — counter-based randomness: a value derived purely from
//     (seed, coordinates). The network uses this so that the fate of message #7
//     on link n1→n3 does not change when some unrelated event elsewhere is
//     removed. That locality is what makes shrinking converge.

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// lowbias32 by Chris Wellons — a strong 32-bit integer finalizer.
export function mix32(x) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function word(p) {
  if (typeof p === 'string') return hashString(p);
  if (p >= 0 && p <= 0xffffffff && Number.isInteger(p)) return p >>> 0;
  // Larger or fractional numbers: fold high and low parts together.
  const hi = Math.floor(p / 4294967296);
  return (mix32(hi) ^ (p >>> 0)) >>> 0;
}

export function hash32(...parts) {
  let h = 0x9e3779b9;
  for (let i = 0; i < parts.length; i++) {
    h = mix32((h ^ word(parts[i])) + Math.imul(i + 1, 0x85ebca6b));
  }
  return h;
}

// Allocation-free variant for the hot path in the network.
export function hash6(a, b, c, d, e, f) {
  let h = 0x9e3779b9;
  h = mix32((h ^ a) + 0x85ebca6b);
  h = mix32((h ^ b) + 0x0b4611d6);
  h = mix32((h ^ c) + 0x9100b041);
  h = mix32((h ^ d) + 0x16fbcb2c);
  h = mix32((h ^ e) + 0x9cb73517);
  h = mix32((h ^ f) + 0x22729f02);
  return h;
}

export const unit = (h) => h / 4294967296;

export class Rng {
  constructor(seed) {
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    this.seed = s;
    this.a = mix32(s ^ 0xa0761d65) | 0;
    this.b = mix32(s ^ 0xe7037ed1) | 0;
    this.c = mix32(s ^ 0x8ebc6af0) | 0;
    this.d = 1;
    for (let i = 0; i < 12; i++) this.next();
  }

  // sfc32 — passes PractRand, tiny state, fast in JS.
  next() {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    this.c = (c + t) | 0;
    return t >>> 0;
  }

  float() { return this.next() / 4294967296; }
  int(n) { return Math.floor(this.float() * n); }
  range(lo, hi) { return lo + this.int(hi - lo + 1); }
  uniform(lo, hi) { return lo + this.float() * (hi - lo); }
  chance(p) { return this.float() < p; }
  pick(arr) { return arr[this.int(arr.length)]; }
  exp(mean) { return -Math.log(1 - this.float()) * mean; }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  subset(arr, p) { return arr.filter(() => this.chance(p)); }

  fork(label) { return new Rng(hash32(this.seed, label)); }
}
