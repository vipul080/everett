import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'everett.js');
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('cli: list shows systems and bugs', () => {
  const r = run(['list']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /raft/);
  assert.match(r.stdout, /forget-vote/);
  assert.match(r.stdout, /lease-lock/);
});

test('cli: explore → repro → replay round trip on worker threads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'everett-'));
  const r = run(['explore', 'raft', '--bug', 'truncate-on-match', '--seeds', '50', '--workers', '2'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /broke/);
  assert.match(r.stdout, /bit-for-bit deterministic/);
  const files = fs.readdirSync(path.join(dir, '.everett'));
  const json = files.find((f) => f.endsWith('.json'));
  assert.ok(json && files.some((f) => f.endsWith('.html')));
  const repro = JSON.parse(fs.readFileSync(path.join(dir, '.everett', json), 'utf8'));
  assert.equal(repro.system, 'raft', 'repros must not embed machine-specific paths');
  const rp = run(['replay', path.join('.everett', json)], dir);
  assert.equal(rp.status, 1);
  assert.match(rp.stdout, /identical universe/);
});

test('cli: a clean explore exits 0', () => {
  const r = run(['explore', 'lease-lock', '--seeds', '100', '--workers', '1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /upheld every invariant/);
});

test('cli: unknown bug is a helpful error', () => {
  const r = run(['explore', 'raft', '--bug', 'nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown bug "nope"/);
});
