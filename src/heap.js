// Binary min-heap of events ordered by (t, seq). seq is a global insertion
// counter, so simultaneous events fire in the order they were scheduled —
// the tie-break is part of what makes a run reproducible.

export class Heap {
  constructor() { this.items = []; }

  get size() { return this.items.length; }
  peek() { return this.items[0]; }

  push(ev) {
    const a = this.items;
    a.push(ev);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(ev, a[p])) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = ev;
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && before(a[r], a[l]) ? r : l;
        if (!before(a[c], last)) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

function before(x, y) {
  return x.t < y.t || (x.t === y.t && x.seq < y.seq);
}
