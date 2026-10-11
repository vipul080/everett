import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { system as raft } from '../examples/raft/index.js';
import { system as leaseLock } from '../examples/lease-lock/index.js';
import { makeScenario } from '../src/scenario.js';
import { runScenario } from '../src/run.js';
import { exploreSync } from '../src/explore.js';
import { shrink } from '../src/shrink.js';
import { narrate } from '../src/narrate.js';
import { bundle } from '../src/node/bundle.js';

test('correct Raft survives 300 universes of chaos', () => {
  const r = exploreSync(raft, { seeds: 300 });
  assert.equal(r.failures.length, 0, r.failures[0]?.result.violation.message);
});

test('correct lease lock (fencing on reads and writes) survives 1000 universes', () => {
  const r = exploreSync(leaseLock, { seeds: 1000 });
  assert.equal(r.failures.length, 0, r.failures[0]?.result.violation.message);
});

// Universes known to expose each planted bug. If an engine change shifts
// these, re-find them with: everett explore raft --bug <name>
const KNOWN = {
  'stale-reads': [47, 'linearizability'],
  'ack-before-commit': [5, 'linearizability'],
  'forget-vote': [515, 'invariant:election-safety'],
  'vote-any-log': [10, 'invariant:leader-completeness'],
  'truncate-on-match': [1, 'invariant:leader-completeness'],
  'lazy-fsync': [17, 'liveness'],
  'figure-8': [1363, 'invariant:leader-completeness'],
};

for (const [bug, [seed, sig]] of Object.entries(KNOWN)) {
  test(`raft bug "${bug}" breaks universe #${seed}, which is fine without the bug`, () => {
    const bad = runScenario(raft, makeScenario(raft, seed, { bugs: [bug] }));
    assert.equal(bad.ok, false);
    assert.equal(bad.violation.signature, sig);
    const good = runScenario(raft, makeScenario(raft, seed));
    assert.equal(good.ok, true, good.violation?.message);
  });
}

test('lease-lock bugs are found quickly', () => {
  for (const bug of Object.keys(leaseLock.bugs)) {
    const r = exploreSync(leaseLock, { seeds: 200, bugs: [bug] });
    assert.equal(r.failures.length, 1, bug);
    assert.equal(r.failures[0].result.violation.signature, 'invariant:lost-update');
  }
});

test('the same universe is the same universe: runs, recordings, bundles', () => {
  const sc = makeScenario(raft, 47, { bugs: ['stale-reads'] });
  const a = runScenario(raft, sc);
  const b = runScenario(raft, sc);
  const c = runScenario(raft, sc, { record: true });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, c.fingerprint, 'recording must not perturb the universe');

  const sandbox = { performance, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundle(['src/index.js', 'examples/raft/index.js', 'examples/lease-lock/index.js']), sandbox);
  const E = sandbox.Everett;
  const d = E.core.runScenario(E.systems.raft, E.core.makeScenario(E.systems.raft, 47, { bugs: ['stale-reads'] }));
  assert.equal(d.fingerprint, a.fingerprint, 'the browser bundle must agree with the modules');
});

test('scenarios are plain JSON and survive a round trip', () => {
  const sc = makeScenario(raft, 123, { bugs: ['stale-reads'] });
  const back = JSON.parse(JSON.stringify(sc));
  assert.equal(runScenario(raft, back).fingerprint, runScenario(raft, sc).fingerprint);
});

test('Math.random inside node code is captured by the determinism guard', () => {
  const sys = {
    name: 'random-user',
    defaults: { nodes: 2, clients: 0, duration: 500 },
    faults: [],
    createNode: (ctx) => ({ onStart() { ctx.setTimer(Math.random() * 100, () => ctx.emit('tick', { r: Math.random() })); } }),
    monitors: () => [],
  };
  const sc = makeScenario(sys, 5);
  const a = runScenario(sys, sc, { record: true });
  const b = runScenario(sys, sc, { record: true });
  assert.deepEqual(a.trace.emits, b.trace.emits);
  assert.equal(a.fingerprint, b.fingerprint);
});

test('shrinking forget-vote yields the four-line story', () => {
  const sc = makeScenario(raft, 515, { bugs: ['forget-vote'] });
  const r = runScenario(raft, sc);
  const s = shrink(raft, sc, r);
  assert.equal(s.result.violation.signature, 'invariant:election-safety');
  assert.ok(s.to.faults <= 1, `expected ≤1 fault, got ${s.to.faults}`);
  assert.ok(s.to.duration < sc.duration / 4);
  const replay = runScenario(raft, s.scenario, { record: true });
  assert.equal(replay.fingerprint, s.result.fingerprint);
  const story = narrate(raft, replay.trace).map((l) => l.text).join('\n');
  assert.match(story, /crashes — the instant after/);
  assert.match(story, /both elected leader/);
});

test('shrinking a stale read resamples down to a handful of faults', () => {
  const sc = makeScenario(raft, 47, { bugs: ['stale-reads'] });
  const r = runScenario(raft, sc);
  const s = shrink(raft, sc, r);
  assert.equal(s.result.violation.signature, 'linearizability');
  assert.ok(s.to.faults <= 3, `expected ≤3 faults, got ${s.to.faults}`);
});
