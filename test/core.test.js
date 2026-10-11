import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hash32 } from '../src/rng.js';
import { Heap } from '../src/heap.js';
import { Disk } from '../src/disk.js';
import { World } from '../src/world.js';
import { clone, components } from '../src/util.js';

test('rng: same seed, same stream; different seeds diverge', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const sa = Array.from({ length: 100 }, () => a.next());
  const sb = Array.from({ length: 100 }, () => b.next());
  const sc = Array.from({ length: 100 }, () => c.next());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
});

test('rng: floats are uniform-ish and in range', () => {
  const r = new Rng(7);
  let sum = 0;
  for (let i = 0; i < 100_000; i++) {
    const x = r.float();
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  assert.ok(Math.abs(sum / 100_000 - 0.5) < 0.01);
});

test('rng: hash32 is order-sensitive and stable', () => {
  assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  assert.notEqual(hash32(1, 2, 3), hash32(3, 2, 1));
  assert.notEqual(hash32('net', 1), hash32('disk', 1));
});

test('heap: pops in (t, seq) order', () => {
  const h = new Heap();
  const r = new Rng(1);
  for (let i = 0; i < 1000; i++) h.push({ t: r.int(50), seq: i });
  let prev = { t: -1, seq: -1 };
  while (h.size) {
    const e = h.pop();
    assert.ok(e.t > prev.t || (e.t === prev.t && e.seq > prev.seq));
    prev = e;
  }
});

test('disk: unsynced writes are lost on crash, synced writes survive', () => {
  const d = new Disk();
  d.set('a', 1);
  d.fsync();
  d.set('b', 2);
  assert.equal(d.get('b'), 2);
  d.crash('all', () => 0);
  assert.equal(d.get('a'), 1);
  assert.equal(d.get('b'), undefined);
});

test('disk: values are copied, never aliased', () => {
  const d = new Disk();
  const v = { log: [1, 2] };
  d.set('k', v);
  v.log.push(3);
  assert.deepEqual(d.get('k'), { log: [1, 2] });
});

test('clone: deep copies plain data', () => {
  const v = { a: [1, { b: 2 }], c: null };
  const w = clone(v);
  assert.deepEqual(w, v);
  w.a[1].b = 9;
  assert.equal(v.a[1].b, 2);
});

test('components: describes partitions as groups', () => {
  const cuts = [['a', 'c'], ['c', 'a'], ['b', 'c'], ['c', 'b']];
  assert.deepEqual(components(['a', 'b', 'c'], cuts), [['a', 'b'], ['c']]);
});

test('world: ping-pong with timers, partitions and crashes is deterministic', () => {
  const run = () => {
    const w = new World({ seed: 9, network: { latency: { min: 1, max: 10 } } });
    const got = [];
    const make = (ctx) => ({
      onStart() { if (ctx.id === 'a') ctx.setTimer(5, () => ctx.send('b', { n: 0 })); },
      onMessage(from, m) {
        got.push(`${ctx.id}:${m.n}@${ctx.now().toFixed(3)}`);
        if (m.n < 20) ctx.send(from, { n: m.n + 1 });
      },
    });
    w.addNode('a', make);
    w.addNode('b', make);
    w.start();
    w.runUntil(1_000_000);
    return { got, fp: w.fingerprint };
  };
  const x = run(), y = run();
  assert.equal(x.got.length, 21);
  assert.deepEqual(x.got, y.got);
  assert.equal(x.fp, y.fp);
});

test('world: crashed nodes lose memory and timers; restart recovers from disk', () => {
  const w = new World({ seed: 1 });
  const seen = [];
  w.addNode('a', (ctx) => ({
    onStart() {
      seen.push(ctx.disk.get('boots') ?? 0);
      ctx.disk.set('boots', (ctx.disk.get('boots') ?? 0) + 1);
      ctx.disk.fsync();
      ctx.setTimer(100, () => seen.push('timer'));
    },
  }));
  w.start();
  w.at(50_000, () => w.crash('a'));
  w.at(60_000, () => w.restart('a'));
  w.runUntil(1_000_000);
  assert.deepEqual(seen, [0, 1, 'timer']);
});

test('world: paused nodes receive their backlog late, in order', () => {
  const w = new World({ seed: 3, network: { latency: { min: 1, max: 1 } } });
  const got = [];
  w.addNode('a', (ctx) => ({ onStart() { for (let i = 0; i < 5; i++) ctx.setTimer(10 + i, () => ctx.send('b', i)); } }));
  w.addNode('b', (ctx) => ({ onMessage(_, m) { got.push([m, ctx.now()]); } }));
  w.start();
  w.at(0, () => w.pause('b'));
  w.at(500_000, () => w.resume('b'));
  w.runUntil(1_000_000);
  assert.deepEqual(got.map((x) => x[0]), [0, 1, 2, 3, 4]);
  assert.ok(got.every((x) => x[1] === 500));
});

test('world: exceptions in node code become findings', () => {
  const w = new World({ seed: 1 });
  w.addNode('a', () => ({ onStart() { null.boom(); } }));
  w.start();
  assert.match(w.violation.signature, /^exception:TypeError/);
});
