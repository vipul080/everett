#!/usr/bin/env node
// everett — run your distributed system in ten thousand universes.

import fs from 'node:fs';
import path from 'node:path';
import { loadSystem, BUILTIN } from '../src/node/systems.js';
import { exploreParallel, defaultWorkers } from '../src/node/parallel.js';
import { buildLabHtml } from '../src/node/bundle.js';
import { makeScenario } from '../src/scenario.js';
import { runScenario } from '../src/run.js';
import { exploreSync } from '../src/explore.js';
import { shrink, scenarioSize } from '../src/shrink.js';
import { narrate } from '../src/narrate.js';
import { fmtTime } from '../src/util.js';

// ── terminal styling ─────────────────────────────────────────────────────────

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (a, b) => (s) => (tty ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39),
  yellow: sgr(33, 39), blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39), gray: sgr(90, 39),
};
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });
const out = (s = '') => process.stdout.write(s + '\n');
const status = (s) => { if (tty) process.stdout.write('\r\x1b[2K' + s); };
const clearStatus = () => { if (tty) process.stdout.write('\r\x1b[2K'); };

function bar(frac, width = 28) {
  const full = Math.round(frac * width);
  return c.cyan('█'.repeat(full)) + c.gray('░'.repeat(width - full));
}

const num = (n) => n.toLocaleString('en-US');

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], bug: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { args._.push(a); continue; }
    const [flag, inline] = a.replace(/^--?/, '').split('=');
    const take = () => inline ?? argv[++i];
    switch (flag) {
      case 'bug': case 'b': args.bug.push(...take().split(',').filter(Boolean)); break;
      case 'no-shrink': args.noShrink = true; break;
      case 'json': args.json = true; break;
      case 'help': case 'h': args.help = true; break;
      case 'o': case 'out': args.out = take(); break;
      case 'faults': args.faults = take().split(','); break;
      default: args[flag] = take();
    }
  }
  return args;
}

function overridesFrom(args) {
  const o = {};
  if (args.nodes) o.nodes = +args.nodes;
  if (args.clients) o.clients = +args.clients;
  if (args.duration) o.duration = +args.duration;
  if (args.faults) o.faults = args.faults;
  if (args.latency) o.latency = args.latency;
  if (args.drop) o.drop = +args.drop;
  if (args.dup) o.dup = +args.dup;
  return o;
}

const HELP = `
${c.bold('everett')} — deterministic multiverse testing for distributed systems

${c.bold('USAGE')}
  everett explore [system] [options]   search universes for a failure, shrink it, save a repro
  everett run [system] --seed <n>      run one universe and report
  everett replay <repro.json>          re-run a repro and verify it is bit-for-bit identical
  everett viz <repro.json> [-o file]   write the time-travel debugger for a repro
  everett lab [-o file]                write the in-browser lab (explore from a web page)
  everett list                         built-in systems and their planted bugs

${c.bold('SYSTEMS')}
  ${Object.keys(BUILTIN).join(', ')}, or a path to a module exporting { system }

${c.bold('OPTIONS')}
  --bug <name>          enable a planted bug (repeatable, or comma-separated)
  --seeds <n>           universes to explore            (default 2000)
  --start <n>           first seed                      (default 1)
  --workers <n>         parallel worker threads         (default ${defaultWorkers()})
  --nodes <n>           pin cluster size
  --clients <n>         pin number of clients
  --duration <ms>       pin universe length
  --faults <a,b>        only these fault types: partition,crash,pause,clock
  --no-shrink           report the first failure as found
  --out <dir>           where repros are written       (default .everett)

${c.bold('EXAMPLES')}
  everett explore raft --bug stale-reads
  everett explore raft --seeds 20000              ${c.dim('# hunt for bugs in the correct implementation')}
  everett explore lease-lock --bug no-fencing
  everett replay .everett/raft-stale-reads-47.json
`;

// ── narration ────────────────────────────────────────────────────────────────

function printStory(system, trace) {
  const lines = narrate(system, trace);
  for (const l of lines) {
    const t = c.gray(fmtTime(l.t).padStart(8));
    let text = l.text;
    if (l.kind === 'fault') text = c.yellow('⚡ ' + text);
    else if (l.kind === 'event') text = c.cyan('  ' + text);
    else if (l.kind === 'op') text = c.dim('  ' + text);
    else if (l.kind === 'culprit') text = c.red(c.bold('✗ ' + text));
    else if (l.kind === 'violation') continue;
    out(`   ${t}  ${text}`);
  }
}

function printViolation(v) {
  out(`  ${c.red(c.bold('✗ ' + v.signature))}  ${c.gray('at ' + fmtTime(v.time))}`);
  out(`    ${wrap(v.message, 84).join('\n    ')}`);
}

function wrap(text, width) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

function sizeLine(from, to) {
  const arrow = (a, b, f = (x) => x) => (a === b ? f(a) : `${f(a)} → ${c.bold(f(b))}`);
  return [
    `faults ${arrow(from.faults, to.faults)}`,
    `ops ${arrow(from.ops, to.ops)}`,
    `nodes ${arrow(from.nodes, to.nodes)}`,
    `clients ${arrow(from.clients, to.clients)}`,
    `time ${arrow(from.duration, to.duration, fmtTime)}`,
  ].join(c.gray(' · '));
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdExplore(args) {
  const { system, url, ref } = await loadSystem(args._[1] || 'raft');
  validateBugs(system, args.bug);
  const seeds = +(args.seeds ?? 2000);
  const start = +(args.start ?? 1);
  const workers = +(args.workers ?? defaultWorkers());
  const overrides = overridesFrom(args);

  out();
  out(`  ${c.bold('everett')} ${c.gray('·')} ${system.title || system.name} ${c.gray('·')} ` +
    (args.bug.length ? c.magenta('bugs: ' + args.bug.join(', ')) : c.green('no planted bugs')));
  out(c.gray(`  exploring ${num(seeds)} universes from seed ${start} on ${workers} worker${workers > 1 ? 's' : ''}`));
  out();

  let last = 0;
  const t0 = performance.now();
  const progress = (_, explored) => {
    const now = performance.now();
    if (now - last < 80) return;
    last = now;
    const rate = explored / ((now - t0) / 1000);
    status(`  ${bar(explored / seeds)} ${num(explored).padStart(7)}/${num(seeds)}  ${c.gray(num(Math.round(rate)) + ' universes/s')}`);
  };

  let explored, failureSeed, elapsed, events = 0;
  if (workers > 1) {
    const r = await exploreParallel({ systemUrl: url, seeds, start, bugs: args.bug, overrides, workers, onProgress: progress });
    ({ explored, elapsed, events } = r);
    failureSeed = r.failure?.seed;
  } else {
    const r = exploreSync(system, {
      seeds, start, bugs: args.bug, overrides,
      onUniverse: ({ result, explored: n }) => { events += result.stats.events; progress(null, n); },
    });
    ({ explored, elapsed } = r);
    failureSeed = r.failures[0]?.seed;
  }
  clearStatus();
  const rate = Math.round(explored / (elapsed / 1000));
  const evRate = (events / (elapsed / 1000) / 1e6).toFixed(1);

  if (failureSeed === undefined) {
    out(`  ${c.green(c.bold('✓'))} all ${num(explored)} universes upheld every invariant ` +
      c.gray(`(${(elapsed / 1000).toFixed(1)}s · ${num(rate)} universes/s · ${evRate}M events/s)`));
    out();
    return 0;
  }

  out(`  ${c.red(c.bold('✗'))} universe ${c.bold('#' + failureSeed)} broke after ${num(explored)} universes ` +
    c.gray(`(${(elapsed / 1000).toFixed(1)}s · ${num(rate)} universes/s)`));
  const scenario = makeScenario(system, failureSeed, { ...overrides, bugs: args.bug });
  const found = runScenario(system, scenario);
  printViolation(found.violation);
  out();

  let final = { scenario, result: found };
  let shrinkInfo = null;
  if (!args.noShrink) {
    const s0 = performance.now();
    const s = shrink(system, scenario, found, {
      onStep: (st) => status(`  ${c.cyan('shrinking')} ${c.gray('replay ' + st.runs)}  ${sizeLine(scenarioSize(scenario, found), st.size)}`),
    });
    clearStatus();
    out(`  ${c.cyan('shrunk')} in ${s.runs} replays ${c.gray(`(${Math.round(performance.now() - s0)}ms)`)}`);
    out(`    ${sizeLine(s.from, s.to)}`);
    out();
    final = s;
    shrinkInfo = { from: s.from, to: s.to, runs: s.runs, steps: s.steps };
  }

  const replay = runScenario(system, final.scenario, { record: true });
  const deterministic = replay.fingerprint === final.result.fingerprint && !replay.ok;
  out(`  ${c.bold('minimal reproduction')} ${c.gray(`(seed ${final.scenario.seed})`)}`);
  printStory(system, replay.trace);
  out();
  printViolation(replay.violation || final.result.violation);
  out();
  out(`  ${deterministic ? c.green('✓') : c.red('✗')} replay is ${deterministic ? '' : 'NOT '}bit-for-bit deterministic ` +
    c.gray(`(fingerprint ${replay.fingerprint.slice(0, 16)})`));

  const dir = args.out || '.everett';
  fs.mkdirSync(dir, { recursive: true });
  const base = `${system.name}-${args.bug.join('+') || 'correct'}-${failureSeed}`;
  const reproPath = path.join(dir, base + '.json');
  const htmlPath = path.join(dir, base + '.html');
  const repro = {
    everett: 1,
    system: ref,
    bugs: args.bug,
    found: { seed: failureSeed, explored },
    shrink: shrinkInfo,
    violation: replay.violation || final.result.violation,
    fingerprint: replay.fingerprint,
    scenario: final.scenario,
  };
  fs.writeFileSync(reproPath, JSON.stringify(repro, null, 2));
  fs.writeFileSync(htmlPath, buildLabHtml({ trace: replay.trace, system }));
  out(`  ${c.gray('→')} repro saved       ${c.bold(reproPath)}`);
  out(`  ${c.gray('→')} time-travel view  ${c.bold(htmlPath)}`);
  out(`  ${c.gray('→')} replay any time   ${c.dim('everett replay ' + reproPath)}`);
  out();
  return 1;
}

async function cmdRun(args) {
  const { system } = await loadSystem(args._[1] || 'raft');
  validateBugs(system, args.bug);
  const seed = +(args.seed ?? 1);
  const scenario = makeScenario(system, seed, { ...overridesFrom(args), bugs: args.bug });
  const t0 = performance.now();
  const r = runScenario(system, scenario, { record: !!args.out });
  const dt = performance.now() - t0;
  if (args.json) { out(JSON.stringify({ seed, ok: r.ok, violation: r.violation, stats: r.stats, fingerprint: r.fingerprint }, null, 2)); return r.ok ? 0 : 1; }
  out();
  out(`  universe ${c.bold('#' + seed)} ${c.gray('·')} ${system.name} ${c.gray('·')} ${scenario.nodes.length} nodes, ` +
    `${scenario.clients.length} clients, ${scenario.faults.length + scenario.triggers.length} faults, ${fmtTime(scenario.duration)}`);
  out(c.gray(`  ${num(r.stats.events)} events · ${num(r.stats.sent)} messages (${num(r.stats.dropped)} lost) · ` +
    `${num(r.stats.ops)} ops · ran in ${dt.toFixed(1)}ms · fingerprint ${r.fingerprint.slice(0, 16)}`));
  if (r.ok) out(`  ${c.green('✓ every invariant held')}`);
  else printViolation(r.violation);
  if (args.out) {
    fs.writeFileSync(args.out, buildLabHtml({ trace: r.trace, system }));
    out(`  ${c.gray('→')} time-travel view ${c.bold(args.out)}`);
  }
  out();
  return r.ok ? 0 : 1;
}

function readRepro(file) {
  if (!file) throw new Error('usage: everett replay <repro.json>');
  const repro = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!repro.scenario) throw new Error(`${file} is not an everett repro`);
  return repro;
}

async function cmdReplay(args) {
  const repro = readRepro(args._[1]);
  const { system } = await loadSystem(repro.system);
  const r = runScenario(system, repro.scenario, { record: true });
  const same = r.fingerprint === repro.fingerprint;
  out();
  out(`  replaying ${c.bold(path.basename(args._[1]))} ${c.gray(`· ${system.name} · seed ${repro.scenario.seed}`)}`);
  printStory(system, r.trace);
  out();
  if (r.violation) printViolation(r.violation);
  else out(`  ${c.green('✓ no violation')} ${c.gray('(the bug may have been fixed)')}`);
  out();
  out(`  ${same ? c.green('✓ identical universe') : c.yellow('≠ different universe')} ` +
    c.gray(`fingerprint ${r.fingerprint.slice(0, 16)} ${same ? '==' : '!='} ${String(repro.fingerprint).slice(0, 16)}`));
  if (args.out) {
    fs.writeFileSync(args.out, buildLabHtml({ trace: r.trace, system }));
    out(`  ${c.gray('→')} time-travel view ${c.bold(args.out)}`);
  }
  out();
  return r.violation ? 1 : 0;
}

async function cmdViz(args) {
  const repro = readRepro(args._[1]);
  const { system } = await loadSystem(repro.system);
  const r = runScenario(system, repro.scenario, { record: true });
  const file = args.out || args._[1].replace(/\.json$/, '') + '.html';
  fs.writeFileSync(file, buildLabHtml({ trace: r.trace, system }));
  out(`  ${c.gray('→')} ${c.bold(file)}`);
  return 0;
}

async function cmdLab(args) {
  const file = args.out || 'everett-lab.html';
  fs.writeFileSync(file, buildLabHtml({}));
  out(`  ${c.gray('→')} ${c.bold(file)}  ${c.gray('open it in a browser — the whole multiverse runs client-side')}`);
  return 0;
}

async function cmdList() {
  out();
  for (const name of Object.keys(BUILTIN)) {
    const { system } = await loadSystem(name);
    out(`  ${c.bold(name)} ${c.gray('—')} ${system.summary}`);
    for (const [bug, desc] of Object.entries(system.bugs || {})) {
      out(`    ${c.magenta(bug.padEnd(19))} ${wrap(desc, 70).join('\n' + ' '.repeat(24))}`);
    }
    out();
  }
  return 0;
}

function validateBugs(system, bugs) {
  for (const b of bugs) {
    if (!system.bugs || !(b in system.bugs)) {
      throw new Error(`unknown bug "${b}" for ${system.name}. Known: ${Object.keys(system.bugs || {}).join(', ') || 'none'}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const commands = { explore: cmdExplore, run: cmdRun, replay: cmdReplay, viz: cmdViz, lab: cmdLab, list: cmdList };
const cmd = commands[args._[0]];
if (!cmd || args.help) {
  out(HELP);
  process.exit(cmd || args.help ? 0 : 2);
}
try {
  process.exitCode = await cmd(args);
} catch (err) {
  clearStatus();
  console.error(`  ${c.red('error:')} ${err.message}`);
  if (process.env.EVERETT_DEBUG) console.error(err.stack);
  process.exitCode = 2;
}
