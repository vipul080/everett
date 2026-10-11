import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinearizable } from '../src/checker/linearizability.js';
import { kvModel } from '../src/checker/models.js';

let id = 0;
const op = (f, key, value, invoke, complete, output, type = 'ok') =>
  ({ id: id++, process: id, client: 'c' + (id % 3), f, key, value, invoke, complete, output, type });

test('sequential history is linearizable', () => {
  const h = [
    op('put', 'x', 1, 0, 10, true),
    op('get', 'x', undefined, 20, 30, 1),
    op('put', 'x', 2, 40, 50, true),
    op('get', 'x', undefined, 60, 70, 2),
  ];
  assert.equal(checkLinearizable(h, kvModel).ok, true);
});

test('stale read is caught and explained', () => {
  const h = [
    op('put', 'x', 1, 0, 10, true),
    op('put', 'x', 2, 20, 30, true),
    op('get', 'x', undefined, 40, 50, 1),
  ];
  const r = checkLinearizable(h, kvModel);
  assert.equal(r.ok, false);
  assert.equal(r.culprit.f, 'get');
  assert.match(kvModel.explain(r), /stale read/);
});

test('concurrent operations may take effect in either order', () => {
  const h = [
    op('put', 'x', 1, 0, 100, true),
    op('put', 'x', 2, 10, 90, true),
    op('get', 'x', undefined, 120, 130, 1),
  ];
  assert.equal(checkLinearizable(h, kvModel).ok, true);
});

test('unknown-outcome writes may or may not have happened', () => {
  const happened = [
    op('put', 'x', 1, 0, 10, true),
    op('put', 'x', 2, 20, null, undefined, 'info'),
    op('get', 'x', undefined, 500, 510, 2),
  ];
  const didnt = [
    op('put', 'x', 1, 0, 10, true),
    op('put', 'x', 2, 20, null, undefined, 'info'),
    op('get', 'x', undefined, 500, 510, 1),
  ];
  assert.equal(checkLinearizable(happened, kvModel).ok, true);
  assert.equal(checkLinearizable(didnt, kvModel).ok, true);
});

test('a write that "happens twice" is not linearizable', () => {
  const h = [
    op('put', 'x', 1, 0, 10, true),
    op('get', 'x', undefined, 20, 30, 1),
    op('put', 'x', 2, 40, 50, true),
    op('get', 'x', undefined, 60, 70, 1),
  ];
  assert.equal(checkLinearizable(h, kvModel).ok, false);
});

test('compare-and-set outcomes constrain the order', () => {
  const ok = [
    op('put', 'x', 1, 0, 10, true),
    op('cas', 'x', [1, 5], 20, 30, true),
    op('get', 'x', undefined, 40, 50, 5),
  ];
  const bad = [
    op('put', 'x', 1, 0, 10, true),
    op('cas', 'x', [1, 5], 20, 30, false),
    op('get', 'x', undefined, 40, 50, 1),
  ];
  assert.equal(checkLinearizable(ok, kvModel).ok, true);
  assert.equal(checkLinearizable(bad, kvModel).ok, false);
});

test('phantom values are explained', () => {
  const h = [op('put', 'x', 1, 0, 10, true), op('get', 'x', undefined, 20, 30, 99)];
  const r = checkLinearizable(h, kvModel);
  assert.equal(r.ok, false);
  assert.match(kvModel.explain(r), /phantom/);
});

test('keys are checked independently', () => {
  const h = [
    op('put', 'x', 1, 0, 10, true),
    op('put', 'y', 2, 0, 10, true),
    op('get', 'x', undefined, 20, 30, 1),
    op('get', 'y', undefined, 20, 30, 2),
  ];
  assert.equal(checkLinearizable(h, kvModel).ok, true);
});
