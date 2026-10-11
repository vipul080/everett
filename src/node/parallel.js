// Parallel universes, literally: spread the seed space across worker threads.
//
// Universes are independent and deterministic, so the only coordination is
// handing out seed batches. When any worker reports a failure we stop handing
// out work, let in-flight batches finish, and report the *lowest* failing seed
// seen — the result doesn't depend on which core happened to be fastest.

import { Worker } from 'node:worker_threads';
import os from 'node:os';

export function defaultWorkers() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, n - 1);
}

export function exploreParallel({
  systemUrl, seeds = 1000, start = 1, bugs = [], overrides = {},
  workers = defaultWorkers(), batch = 24, onProgress,
}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const end = start + seeds;
    let next = start;
    let explored = 0;
    let events = 0;
    let failure = null;
    let busy = 0;
    const pool = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const w of pool) w.terminate();
      resolve({ explored, failure, events, elapsed: performance.now() - t0, workers: pool.length });
    };

    const feed = (w) => {
      if (failure || next >= end) {
        if (busy === 0) finish();
        return;
      }
      const list = [];
      while (list.length < batch && next < end) list.push(next++);
      busy++;
      w.postMessage({ type: 'batch', seeds: list, bugs, overrides });
    };

    const url = new URL('./worker.js', import.meta.url);
    for (let i = 0; i < Math.max(1, workers); i++) {
      const w = new Worker(url, { workerData: { systemUrl } });
      pool.push(w);
      w.on('message', (msg) => {
        if (msg.type === 'ready') return feed(w);
        if (msg.type !== 'results') return;
        busy--;
        for (const r of msg.results) {
          explored++;
          events += r.events;
          onProgress?.(r, explored);
          if (!r.ok && (!failure || r.seed < failure.seed)) failure = r;
        }
        feed(w);
      });
      w.on('error', (err) => {
        if (!settled) { settled = true; for (const x of pool) x.terminate(); reject(err); }
      });
    }
  });
}
