// Everett Lab: the time-travel debugger and the in-browser multiverse.
//
// Everything runs client-side. The same engine the CLI uses explores
// universes here, shrinks the first one that breaks, replays it with full
// recording, and hands the trace to the space-time diagram below.

import { makeScenario, runScenario, exploreAsync, shrink, narrate, fmtTime, models } from '../src/index.js';
import { system as raft } from '../examples/raft/index.js';
import { system as leaseLock } from '../examples/lease-lock/index.js';
import { system as gossip } from '../examples/gossip-register/index.js';

const SYSTEMS = { raft, 'lease-lock': leaseLock, 'gossip-register': gossip };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const AXIS_H = 26, LABEL_W = 64, PAD_R = 16, NODE_H = 46, CLIENT_H = 30, BOTTOM = 12;

const ROLE_COLOR = {
  leader: 'leader', candidate: 'candidate', follower: 'follower',
  locked: 'leader', free: 'follower', store: 'm-teal',
  reading: 'm-blue', working: 'leader', writing: 'm-orange',
  acquiring: 'follower', waiting: 'follower', idle: 'follower',
};

const S = {
  system: raft,
  trace: null,
  m: null,
  view: { t0: 0, t1: 1 },
  cursor: 0,
  playing: false,
  speed: 0.1,
  hidden: new Set(),
  hover: null,
  colors: {},
  exploring: false,
  grid: null,
  fingerprint: null,
  bugs: [],
};

// ── colours ──────────────────────────────────────────────────────────────────

const COLOR_KEYS = ['bg', 'panel', 'panel-2', 'border', 'text', 'muted', 'faint', 'grid', 'accent', 'leader', 'candidate',
  'follower', 'ok', 'info', 'failop', 'bad', 'fault', 'pause', 'm-blue', 'm-teal', 'm-violet', 'm-orange', 'm-red', 'm-gray'];

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of COLOR_KEYS) S.colors[k] = cs.getPropertyValue('--' + k).trim();
}
const col = (k) => S.colors[k] || '#888';
const msgColor = (type) => col('m-' + ((S.system.messageColors || {})[type] || 'gray'));
const roleColor = (role) => col(ROLE_COLOR[role] || 'm-gray');
const termColor = (term) => `hsl(${(term * 67 + 190) % 360} 70% 62%)`;

function alpha(color, a) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

// ── trace → render model ─────────────────────────────────────────────────────

function prepare(trace, system) {
  const lanes = [
    ...trace.nodes.map((id) => ({ id, kind: 'node', h: NODE_H })),
    ...trace.clients.map((id) => ({ id, kind: 'client', h: CLIENT_H })),
  ];
  let y = AXIS_H;
  for (const l of lanes) { l.y = y + l.h / 2; y += l.h; }
  const height = y + BOTTOM;
  const laneOf = new Map(lanes.map((l) => [l.id, l]));
  const end = Math.max(trace.end, 1);

  // Per-node snapshots for "state at time t".
  const snaps = new Map(trace.nodes.map((id) => [id, []]));
  for (const s of trace.snapshots) snaps.get(s.node)?.push(s);

  // Role/status segments per node lane.
  const segs = new Map();
  for (const id of trace.nodes) {
    const evs = [];
    for (const s of snaps.get(id)) evs.push({ t: s.t, role: s.state && s.state.role });
    for (const l of trace.life) if (l.node === id) evs.push({ t: l.t, life: l.what });
    evs.sort((a, b) => a.t - b.t);
    const out = [];
    let role = null, status = 'up', t0 = 0;
    const close = (t) => { if (t > t0) out.push({ t0, t1: t, role, status }); t0 = t; };
    for (const e of evs) {
      if (e.life) {
        const next = e.life === 'crash' ? 'down' : e.life === 'pause' ? 'paused' : (e.life === 'resume' || e.life === 'restart' || e.life === 'boot') ? 'up' : status;
        if (next !== status) { close(e.t); status = next; }
      } else if (e.role !== role) { close(e.t); role = e.role; }
    }
    close(end);
    segs.set(id, out);
  }

  // Partition bands.
  const bands = [];
  let open = null;
  for (const f of trace.faults) {
    if (f.type === 'partition') {
      if (open) { open.t1 = f.t; bands.push(open); }
      open = { t0: f.t, t1: end, kind: f.kind, cuts: f.cuts, trigger: f.trigger };
    } else if ((f.type === 'heal' || f.type === 'heal-all') && open) {
      open.t1 = f.t; bands.push(open); open = null;
    }
  }
  if (open) bands.push(open);

  // Markers: faults and narrated events.
  const marks = [];
  for (const f of trace.faults) {
    if (f.node && laneOf.has(f.node)) marks.push({ t: f.t, lane: laneOf.get(f.node), kind: 'fault', f });
  }
  for (const e of trace.emits) {
    const text = system.describe ? system.describe(e) : null;
    if (!text || !laneOf.has(e.node)) continue;
    marks.push({ t: e.t, lane: laneOf.get(e.node), kind: 'emit', e, text });
  }

  const types = [...new Set(trace.messages.map((m) => m.type))];
  const v = trace.violation;
  const involved = v && v.involved ? new Set(v.involved) : null;

  const times = new Set();
  for (const m of trace.messages) { times.add(m.sent); if (m.recv !== null) times.add(m.recv); }
  for (const e of trace.emits) times.add(e.t);
  for (const f of trace.faults) times.add(f.t);
  for (const o of trace.history) { times.add(o.invoke); if (o.complete !== null) times.add(o.complete); }

  // Message density for the scrubber.
  const BINS = 400;
  const density = new Float32Array(BINS);
  for (const m of trace.messages) density[Math.min(BINS - 1, Math.floor((m.sent / end) * BINS))]++;

  return {
    lanes, laneOf, height, end, snaps, segs, bands, marks, types, involved,
    times: [...times].sort((a, b) => a - b),
    density,
    story: narrate(system, trace, { maxLines: 60 }),
  };
}

// ── loading ──────────────────────────────────────────────────────────────────

function loadTrace(trace, system, { fingerprint = null, bugs = [] } = {}) {
  S.trace = trace;
  S.system = system;
  S.fingerprint = fingerprint || trace.fingerprint || null;
  S.bugs = bugs.length ? bugs : (trace.scenario?.bugs || []);
  S.m = prepare(trace, system);
  S.hidden = new Set();
  S.playing = false;
  $('btn-play').textContent = '▶';
  buildChips();
  renderVerdict();
  renderStory();
  layout();
  if (trace.violation) focusViolation(); else fit();
  setCursor(trace.violation ? Math.max(0, trace.violation.time - (S.view.t1 - S.view.t0) * 0.15) : 0);
}

function renderVerdict() {
  const t = S.trace, el = $('verdict');
  const seed = t.scenario ? `seed ${t.scenario.seed}` : '';
  const meta = `${S.system.name} · ${seed}${S.bugs.length ? ' · bug: ' + S.bugs.join(', ') : ''}`;
  if (t.violation) {
    el.className = 'verdict bad';
    el.innerHTML = `✗ ${esc(t.violation.message)}<span class="meta">${esc(meta)}</span>`;
    el.title = t.violation.message;
  } else {
    el.className = 'verdict good';
    el.innerHTML = `✓ every invariant held<span class="meta">${esc(meta)}</span>`;
    el.title = '';
  }
}

function buildChips() {
  const box = $('msg-filter');
  box.innerHTML = '';
  for (const type of S.m.types) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<i style="background:${msgColor(type)}"></i>${esc(type)}`;
    chip.onclick = () => {
      if (S.hidden.has(type)) S.hidden.delete(type); else S.hidden.add(type);
      chip.classList.toggle('off', S.hidden.has(type));
      draw();
    };
    box.appendChild(chip);
  }
}

// ── view & cursor ────────────────────────────────────────────────────────────

const canvas = $('diagram');
const ctx2 = canvas.getContext('2d');
let W = 800, H = 300, dpr = 1;

function layout() {
  if (!S.m) return;
  dpr = window.devicePixelRatio || 1;
  W = canvas.parentElement.clientWidth;
  H = S.m.height;
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  layoutScrub();
  draw();
}

const plotW = () => W - LABEL_W - PAD_R;
const xOf = (t) => LABEL_W + ((t - S.view.t0) / (S.view.t1 - S.view.t0)) * plotW();
const tOf = (x) => S.view.t0 + ((x - LABEL_W) / plotW()) * (S.view.t1 - S.view.t0);

function setView(t0, t1) {
  const end = S.m.end;
  const span = clamp(t1 - t0, 200, end * 1.05);
  t0 = clamp(t0, -end * 0.02, end * 1.02 - span);
  S.view = { t0, t1: t0 + span };
  draw();
}

function fit() { setView(-S.m.end * 0.01, S.m.end * 1.01); }

function focusViolation() {
  const v = S.trace.violation;
  if (!v) return fit();
  const span = Math.min(S.m.end, Math.max(60_000, v.time * 0.35));
  setView(v.time - span * 0.8, v.time + span * 0.2);
}

function setCursor(t) {
  S.cursor = clamp(t, 0, S.m.end);
  const span = S.view.t1 - S.view.t0;
  if (S.cursor < S.view.t0 || S.cursor > S.view.t1) setView(S.cursor - span * 0.5, S.cursor + span * 0.5);
  $('clock').textContent = fmtT(S.cursor, span);
  renderState();
  updateStory();
  draw();
}

function fmtT(t, span = 1e6) {
  return (t / 1e6).toFixed(span < 20_000 ? 6 : span < 200_000 ? 4 : 3) + 's';
}

// ── drawing ──────────────────────────────────────────────────────────────────

function niceStep(span) {
  const target = span / Math.max(4, plotW() / 110);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7];
  return steps.find((s) => s >= target) || 1e7;
}

function tickLabel(t, step) {
  if (step >= 1e6) return `${t / 1e6}s`;
  if (step >= 1e3) return `${+(t / 1e3).toFixed(3)}ms`;
  return `${t}µs`;
}

function visibleMessages() {
  const { t0, t1 } = S.view;
  return S.trace.messages.filter((m) => {
    if (S.hidden.has(m.type)) return false;
    const r = m.recv === null ? S.m.end : m.recv;
    return !(r < t0 || m.sent > t1);
  });
}

function draw() {
  if (!S.m) return;
  const g = ctx2;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = col('panel');
  g.fillRect(0, 0, W, H);
  const { lanes, laneOf } = S.m;
  const nodeLanes = lanes.filter((l) => l.kind === 'node');
  const nodesTop = AXIS_H, nodesBottom = nodeLanes.length ? nodeLanes[nodeLanes.length - 1].y + NODE_H / 2 : AXIS_H;
  const span = S.view.t1 - S.view.t0;

  g.save();
  g.beginPath();
  g.rect(LABEL_W, 0, plotW(), H);
  g.clip();

  // Partition bands.
  for (const b of S.m.bands) {
    if (b.t1 < S.view.t0 || b.t0 > S.view.t1) continue;
    const x0 = xOf(b.t0), x1 = xOf(b.t1);
    g.fillStyle = alpha(col('fault'), 0.09);
    g.fillRect(x0, nodesTop, x1 - x0, nodesBottom - nodesTop);
    g.strokeStyle = alpha(col('fault'), 0.5);
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x0 + 0.5, nodesTop); g.lineTo(x0 + 0.5, nodesBottom); g.stroke();
    g.setLineDash([]);
    if (x1 - x0 > 60) {
      g.fillStyle = col('fault');
      g.font = '10px ' + getMono();
      g.fillText(`⟂ ${b.kind}`, Math.max(x0, LABEL_W) + 4, nodesTop + 11);
    }
  }

  // Time grid.
  const step = niceStep(span);
  g.strokeStyle = col('grid');
  g.fillStyle = col('muted');
  g.font = '10px ' + getMono();
  g.lineWidth = 1;
  for (let t = Math.ceil(S.view.t0 / step) * step; t <= S.view.t1; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    g.beginPath(); g.moveTo(x, AXIS_H - 6); g.lineTo(x, H - BOTTOM); g.stroke();
    g.fillText(tickLabel(t, step), x + 3, 15);
  }

  // Lane baselines and node role segments.
  for (const l of lanes) {
    g.strokeStyle = col('border');
    g.beginPath(); g.moveTo(LABEL_W, Math.round(l.y) + 0.5); g.lineTo(W, Math.round(l.y) + 0.5); g.stroke();
  }
  for (const l of nodeLanes) {
    for (const s of S.m.segs.get(l.id)) {
      if (s.t1 < S.view.t0 || s.t0 > S.view.t1) continue;
      const x0 = xOf(s.t0), x1 = xOf(s.t1);
      if (s.status === 'down') {
        g.strokeStyle = alpha(col('bad'), 0.8);
        g.setLineDash([2, 4]);
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x0, l.y); g.lineTo(x1, l.y); g.stroke();
        g.setLineDash([]);
      } else if (s.status === 'paused') {
        g.fillStyle = alpha(col('pause'), 0.35);
        g.fillRect(x0, l.y - 6, x1 - x0, 12);
        g.strokeStyle = alpha(col('pause'), 0.9);
        g.lineWidth = 1;
        g.beginPath();
        for (let x = x0 - ((x0 - LABEL_W) % 6); x < x1; x += 6) {
          g.moveTo(Math.max(x, x0), l.y + 6); g.lineTo(Math.min(x + 6, x1), l.y - 6);
        }
        g.stroke();
      } else {
        g.fillStyle = roleColor(s.role);
        const thick = s.role === 'leader' || s.role === 'locked' ? 7 : 4;
        g.fillRect(x0, l.y - thick / 2, Math.max(1, x1 - x0), thick);
      }
    }
    g.lineWidth = 1;
  }

  // Client operations.
  const v = S.trace.violation;
  const involved = S.m.involved;
  for (const o of S.trace.history) {
    const l = laneOf.get(o.client);
    if (!l) continue;
    const t1 = o.complete === null ? S.m.end : o.complete;
    if (t1 < S.view.t0 || o.invoke > S.view.t1) continue;
    const x0 = xOf(o.invoke), x1 = Math.max(x0 + 2, xOf(t1));
    const culprit = v && v.culprit === o.id;
    const dim = involved && !involved.has(o.id);
    let fill = o.type === 'ok' ? col('ok') : o.type === 'info' ? col('info') : col('failop');
    if (culprit) fill = col('bad');
    g.fillStyle = alpha(fill, dim ? 0.18 : culprit ? 0.9 : 0.55);
    roundRect(g, x0, l.y - 8, x1 - x0, 16, 3);
    g.fill();
    if (culprit) { g.strokeStyle = col('bad'); g.lineWidth = 2; g.stroke(); g.lineWidth = 1; }
    if (x1 - x0 > 46 && S.system.model) {
      g.fillStyle = dim ? col('faint') : col('text');
      g.font = '10px ' + getMono();
      const label = S.system.model.describe(o);
      g.save(); g.beginPath(); g.rect(x0, l.y - 8, x1 - x0, 16); g.clip();
      g.fillText(label, x0 + 4, l.y + 3.5);
      g.restore();
    }
  }

  // Messages.
  const msgs = visibleMessages();
  const a = clamp(500 / Math.max(1, msgs.length), 0.12, 0.85);
  const arrows = msgs.length < 400;
  const groups = new Map();
  for (const m of msgs) {
    const c = msgColor(m.type);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(m);
  }
  g.lineWidth = 1.1;
  for (const [c, list] of groups) {
    g.strokeStyle = alpha(c, a);
    g.beginPath();
    for (const m of list) {
      const lf = laneOf.get(m.from), lt = laneOf.get(m.to);
      if (!lf || !lt) continue;
      const x0 = xOf(m.sent);
      if (m.drop && m.recv === m.sent) {
        const dy = Math.sign(lt.y - lf.y) * 10;
        g.moveTo(x0, lf.y); g.lineTo(x0 + 8, lf.y + dy);
        continue;
      }
      const x1 = xOf(m.recv === null ? S.m.end : m.recv);
      g.moveTo(x0, lf.y); g.lineTo(x1, lt.y);
    }
    g.stroke();
  }
  // Drop crosses and arrowheads.
  for (const m of msgs) {
    const lf = laneOf.get(m.from), lt = laneOf.get(m.to);
    if (!lf || !lt) continue;
    if (m.drop) {
      let x, y;
      if (m.recv === m.sent) { x = xOf(m.sent) + 8; y = lf.y + Math.sign(lt.y - lf.y) * 10; }
      else { x = xOf(m.recv); y = lt.y; }
      cross(g, x, y, 3, alpha(col('bad'), Math.max(a, 0.5)));
    } else if (arrows && m.recv !== null) {
      arrowHead(g, xOf(m.sent), lf.y, xOf(m.recv), lt.y, alpha(msgColor(m.type), Math.max(a, 0.6)));
    }
  }

  // Hovered message on top.
  if (S.hover && S.hover.kind === 'msg') {
    const m = S.hover.m, lf = laneOf.get(m.from), lt = laneOf.get(m.to);
    g.strokeStyle = msgColor(m.type);
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(xOf(m.sent), lf.y);
    if (m.drop && m.recv === m.sent) g.lineTo(xOf(m.sent) + 8, lf.y + Math.sign(lt.y - lf.y) * 10);
    else g.lineTo(xOf(m.recv ?? S.m.end), lt.y);
    g.stroke();
    g.lineWidth = 1;
  }

  // Messages in flight at the cursor.
  for (const m of msgs) {
    if (m.drop && m.recv === m.sent) continue;
    const r = m.recv === null ? S.m.end : m.recv;
    if (m.sent > S.cursor || r <= S.cursor) continue;
    const lf = laneOf.get(m.from), lt = laneOf.get(m.to);
    const p = (S.cursor - m.sent) / Math.max(1, r - m.sent);
    const x = xOf(m.sent) + (xOf(r) - xOf(m.sent)) * p;
    const y = lf.y + (lt.y - lf.y) * p;
    g.fillStyle = msgColor(m.type);
    g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
  }

  // Event and fault markers.
  for (const mk of S.m.marks) {
    if (mk.t < S.view.t0 || mk.t > S.view.t1) continue;
    const x = xOf(mk.t), y = mk.lane.y;
    if (mk.kind === 'fault') drawFault(g, mk.f, x, y);
    else drawEmit(g, mk.e, x, y);
  }

  // Violation.
  if (v) {
    const x = xOf(v.time);
    g.strokeStyle = col('bad');
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(x, AXIS_H - 4); g.lineTo(x, H - BOTTOM); g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1;
    g.fillStyle = col('bad');
    g.font = '600 10px ' + getMono();
    const label = '✗ violation';
    const lw = g.measureText(label).width;
    g.fillText(label, x + 4 + lw > W - PAD_R ? x - lw - 4 : x + 4, AXIS_H + 10);
  }

  // Cursor.
  const cx = Math.round(xOf(S.cursor)) + 0.5;
  g.strokeStyle = col('accent');
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(cx, AXIS_H - 8); g.lineTo(cx, H - BOTTOM + 4); g.stroke();
  g.fillStyle = col('accent');
  g.beginPath(); g.moveTo(cx - 5, AXIS_H - 12); g.lineTo(cx + 5, AXIS_H - 12); g.lineTo(cx, AXIS_H - 5); g.fill();
  g.lineWidth = 1;
  g.restore();

  // Lane labels (outside the clip).
  g.fillStyle = col('panel');
  g.fillRect(0, 0, LABEL_W, H);
  g.strokeStyle = col('border');
  g.beginPath(); g.moveTo(LABEL_W - 0.5, 0); g.lineTo(LABEL_W - 0.5, H); g.stroke();
  for (const l of lanes) {
    const st = l.kind === 'node' ? statusAt(l.id, S.cursor) : null;
    g.fillStyle = l.kind === 'node' ? col('text') : col('muted');
    g.font = (l.kind === 'node' ? '600 12px ' : '11px ') + getMono();
    g.fillText(l.id, 12, l.y + 4);
    if (st) {
      const snap = snapAt(l.id, S.cursor);
      const role = snap && snap.state ? snap.state.role : null;
      g.fillStyle = st === 'down' ? col('bad') : st === 'paused' ? col('pause') : roleColor(role);
      g.beginPath(); g.arc(LABEL_W - 12, l.y, 4, 0, Math.PI * 2); g.fill();
    }
  }
  drawScrub();
}

let monoFont = null;
function getMono() {
  if (!monoFont) monoFont = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
  return monoFont;
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function cross(g, x, y, s, color) {
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(x - s, y - s); g.lineTo(x + s, y + s);
  g.moveTo(x + s, y - s); g.lineTo(x - s, y + s);
  g.stroke();
  g.lineWidth = 1;
}

function arrowHead(g, x0, y0, x1, y1, color) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const s = 6;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x1 - s * Math.cos(ang - 0.4), y1 - s * Math.sin(ang - 0.4));
  g.lineTo(x1 - s * Math.cos(ang + 0.4), y1 - s * Math.sin(ang + 0.4));
  g.closePath();
  g.fill();
}

function drawFault(g, f, x, y) {
  g.font = '600 12px ' + getMono();
  g.textAlign = 'center';
  if (f.type === 'crash') {
    g.fillStyle = col('panel'); g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    cross(g, x, y, 5, col('bad'));
  } else if (f.type === 'restart') {
    g.fillStyle = col('ok'); g.fillText('↻', x, y - 9);
  } else if (f.type === 'pause') {
    g.fillStyle = col('pause'); g.fillText('⏸', x, y - 9);
  } else if (f.type === 'resume') {
    g.fillStyle = col('pause'); g.fillText('▸', x, y - 9);
  } else if (f.type === 'clock') {
    g.fillStyle = col('fault'); g.fillText(f.rate === 1 ? '⏱' : `⏱${f.rate}×`, x, y - 9);
  }
  if (f.trigger) { g.fillStyle = col('fault'); g.fillText('⚡', x, y + 19); }
  g.textAlign = 'left';
}

function drawEmit(g, e, x, y) {
  if (e.kind === 'leader') {
    g.fillStyle = col('leader');
    star(g, x, y - 12, 5.5);
    g.strokeStyle = col('panel'); g.lineWidth = 1; g.stroke();
  } else if (e.kind === 'truncate' || e.kind === 'fenced' || e.kind === 'expired') {
    g.fillStyle = col('m-red');
    g.fillRect(x - 1, y - 13, 2, 9);
  } else if (e.kind === 'stepdown') {
    g.fillStyle = col('muted');
    g.beginPath(); g.moveTo(x - 4, y - 14); g.lineTo(x + 4, y - 14); g.lineTo(x, y - 8); g.fill();
  } else {
    g.fillStyle = alpha(col('text'), 0.55);
    g.beginPath(); g.arc(x, y - 11, 2.2, 0, Math.PI * 2); g.fill();
  }
}

function star(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
  }
  g.closePath();
  g.fill();
}

// ── scrubber ─────────────────────────────────────────────────────────────────

const scrub = $('scrub-canvas');
const sg = scrub.getContext('2d');
let SW = 800;
const SH = 34;

function layoutScrub() {
  SW = scrub.clientWidth || 800;
  scrub.width = Math.round(SW * dpr);
  scrub.height = Math.round(SH * dpr);
}

function drawScrub() {
  if (!S.m) return;
  const g = sg, end = S.m.end;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, SW, SH);
  const x = (t) => LABEL_W + (t / end) * (SW - LABEL_W - PAD_R);
  g.fillStyle = col('panel-2');
  roundRect(g, LABEL_W, 4, SW - LABEL_W - PAD_R, SH - 8, 5); g.fill();
  const d = S.m.density;
  let max = 1;
  for (const v of d) max = Math.max(max, v);
  g.fillStyle = alpha(col('accent'), 0.35);
  const bw = (SW - LABEL_W - PAD_R) / d.length;
  for (let i = 0; i < d.length; i++) {
    const h = (d[i] / max) * (SH - 12);
    g.fillRect(LABEL_W + i * bw, SH - 6 - h, Math.max(1, bw - 0.3), h);
  }
  for (const b of S.m.bands) { g.fillStyle = alpha(col('fault'), 0.25); g.fillRect(x(b.t0), 4, Math.max(2, x(b.t1) - x(b.t0)), 4); }
  for (const f of S.trace.faults) {
    if (f.type === 'crash' || f.type === 'pause' || f.type === 'heal-all') {
      g.fillStyle = f.type === 'crash' ? col('bad') : f.type === 'pause' ? col('pause') : col('ok');
      g.fillRect(x(f.t) - 1, SH - 8, 2, 4);
    }
  }
  const v = S.trace.violation;
  if (v) { g.fillStyle = col('bad'); g.fillRect(x(v.time) - 1, 2, 2, SH - 4); }
  // Current view window.
  g.strokeStyle = col('accent');
  g.lineWidth = 1;
  const vx0 = x(clamp(S.view.t0, 0, end)), vx1 = x(clamp(S.view.t1, 0, end));
  g.fillStyle = alpha(col('accent'), 0.1);
  g.fillRect(vx0, 2, Math.max(2, vx1 - vx0), SH - 4);
  g.strokeRect(vx0 + 0.5, 2.5, Math.max(2, vx1 - vx0) - 1, SH - 5);
  g.fillStyle = col('accent');
  g.fillRect(x(S.cursor) - 1, 0, 2, SH);
  g.fillStyle = col('muted');
  g.font = '10px ' + getMono();
  g.fillText(fmtTime(end), 4, SH / 2 + 3);
}

function scrubTo(ev) {
  const r = scrub.getBoundingClientRect();
  const t = ((ev.clientX - r.left - LABEL_W) / (SW - LABEL_W - PAD_R)) * S.m.end;
  setCursor(clamp(t, 0, S.m.end));
}

// ── hover & interaction ─────────────────────────────────────────────────────

function hitTest(px, py) {
  if (!S.m || px < LABEL_W) return null;
  const { laneOf } = S.m;
  for (const mk of S.m.marks) {
    if (mk.t < S.view.t0 || mk.t > S.view.t1) continue;
    const x = xOf(mk.t);
    const y = mk.lane.y + (mk.kind === 'emit' ? -11 : 0);
    if (Math.abs(px - x) < 6 && Math.abs(py - y) < 9) return { kind: mk.kind, mk };
  }
  for (const o of S.trace.history) {
    const l = laneOf.get(o.client);
    if (!l || Math.abs(py - l.y) > 9) continue;
    const x0 = xOf(o.invoke), x1 = Math.max(x0 + 2, xOf(o.complete === null ? S.m.end : o.complete));
    if (px >= x0 - 1 && px <= x1 + 1) return { kind: 'op', o };
  }
  let best = null, bestD = 6;
  for (const m of visibleMessages()) {
    const lf = laneOf.get(m.from), lt = laneOf.get(m.to);
    if (!lf || !lt) continue;
    const x0 = xOf(m.sent);
    let x1, y1;
    if (m.drop && m.recv === m.sent) { x1 = x0 + 8; y1 = lf.y + Math.sign(lt.y - lf.y) * 10; }
    else { x1 = xOf(m.recv === null ? S.m.end : m.recv); y1 = lt.y; }
    const d = segDist(px, py, x0, lf.y, x1, y1);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best ? { kind: 'msg', m: best } : null;
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - x0) * dx + (py - y0) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function showTip(hit, px, py) {
  const tip = $('tip');
  if (!hit) { tip.hidden = true; return; }
  let html = '';
  if (hit.kind === 'msg') {
    const m = hit.m;
    const fate = m.drop ? `<span style="color:var(--bad)">dropped (${esc(m.drop)})</span>` :
      m.recv === null ? 'still in flight at the end' : `delivered ${fmtTime(m.recv)} · ${((m.recv - m.sent) / 1000).toFixed(2)}ms`;
    html = `<div class="h">${esc(m.type)} · ${esc(m.from)} → ${esc(m.to)}${m.dupOf ? ' (duplicate)' : ''}</div>
      sent ${fmtTime(m.sent)} · ${fate}<pre>${esc(compact(m.payload))}</pre>`;
  } else if (hit.kind === 'op') {
    const o = hit.o;
    const v = S.trace.violation;
    html = `<div class="h">${esc(o.client)} · ${esc(S.system.model ? S.system.model.describe(o) : o.f)}</div>
      ${o.type === 'info' ? 'outcome unknown (timed out)' : o.type} · invoked ${fmtTime(o.invoke)} · ` +
      (o.complete === null ? 'never completed' : `completed ${fmtTime(o.complete)}`) +
      (v && v.culprit === o.id ? `<div style="color:var(--bad);margin-top:4px">${esc(v.message)}</div>` : '');
  } else if (hit.kind === 'emit') {
    html = `<div class="h">${esc(hit.mk.e.node)} ${esc(hit.mk.text)}</div>${fmtTime(hit.mk.t)}`;
  } else if (hit.kind === 'fault') {
    html = `<div class="h">${esc(describeFaultShort(hit.mk.f))}</div>${fmtTime(hit.mk.t)}`;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrap = $('diagram-wrap').getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = clamp(px + 14, 4, wrap.width - tw - 4) + 'px';
  tip.style.top = clamp(py + 14, 4, Math.max(4, wrap.height - th - 4)) + 'px';
}

function describeFaultShort(f) {
  const why = f.trigger ? ` (right after ${f.trigger.node} ${f.trigger.kind})` : '';
  switch (f.type) {
    case 'crash': return `${f.node} crashes${why}`;
    case 'restart': return `${f.node} restarts`;
    case 'pause': return `${f.node} freezes${why}`;
    case 'resume': return `${f.node} resumes`;
    case 'clock': return f.rate === 1 ? `${f.node} clock corrected` : `${f.node} clock ×${f.rate}`;
    default: return f.type;
  }
}

function compact(v) {
  const s = JSON.stringify(v, (k, x) => (Array.isArray(x) && x.length > 8 ? [...x.slice(0, 8), `…+${x.length - 8}`] : x));
  return s && s.length > 600 ? s.slice(0, 600) + '…' : s;
}

let drag = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (!S.m) return;
  canvas.setPointerCapture(ev.pointerId);
  drag = { x: ev.offsetX, t0: S.view.t0, t1: S.view.t1, moved: false };
});
canvas.addEventListener('pointermove', (ev) => {
  if (!S.m) return;
  if (drag) {
    const dx = ev.offsetX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.moved) {
      const dt = (dx / plotW()) * (drag.t1 - drag.t0);
      setView(drag.t0 - dt, drag.t1 - dt);
      $('tip').hidden = true;
      return;
    }
  }
  const hit = hitTest(ev.offsetX, ev.offsetY);
  const changed = (hit && hit.m) !== (S.hover && S.hover.m);
  S.hover = hit;
  showTip(hit, ev.offsetX, ev.offsetY);
  if (changed) draw();
});
canvas.addEventListener('pointerup', (ev) => {
  if (drag && !drag.moved && ev.offsetX > LABEL_W) setCursor(tOf(ev.offsetX));
  drag = null;
});
canvas.addEventListener('pointerleave', () => { S.hover = null; $('tip').hidden = true; draw(); });
canvas.addEventListener('wheel', (ev) => {
  if (!S.m) return;
  ev.preventDefault();
  const span = S.view.t1 - S.view.t0;
  if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    const dt = (ev.deltaX / plotW()) * span;
    return setView(S.view.t0 + dt, S.view.t1 + dt);
  }
  const at = tOf(ev.offsetX);
  const k = Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022));
  const nspan = clamp(span * k, 200, S.m.end * 1.05);
  const f = (at - S.view.t0) / span;
  setView(at - f * nspan, at - f * nspan + nspan);
}, { passive: false });

let scrubbing = false;
scrub.addEventListener('pointerdown', (ev) => { if (!S.m) return; scrubbing = true; scrub.setPointerCapture(ev.pointerId); scrubTo(ev); });
scrub.addEventListener('pointermove', (ev) => { if (scrubbing) scrubTo(ev); });
scrub.addEventListener('pointerup', () => { scrubbing = false; });

// ── playback & stepping ─────────────────────────────────────────────────────

let lastFrame = 0;
function play() {
  S.playing = !S.playing;
  $('btn-play').textContent = S.playing ? '❚❚' : '▶';
  if (S.playing) {
    if (S.cursor >= S.m.end) S.cursor = 0;
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!S.playing) return;
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  let t = S.cursor + dt * 1000 * S.speed;
  if (t >= S.m.end) { t = S.m.end; play(); }
  const span = S.view.t1 - S.view.t0;
  if (t > S.view.t0 + span * 0.85) S.view = { t0: t - span * 0.15, t1: t - span * 0.15 + span };
  setCursor(t);
  if (S.playing) requestAnimationFrame(tick);
}

function step(dir) {
  const ts = S.m.times;
  let lo = 0, hi = ts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= S.cursor) lo = mid + 1; else hi = mid; }
  // lo = first index with time > cursor
  if (dir > 0 && lo < ts.length) setCursor(ts[lo]);
  if (dir < 0) {
    let i = lo - 1;
    while (i >= 0 && ts[i] >= S.cursor) i--;
    if (i >= 0) setCursor(ts[i]);
  }
}

// ── state panel ─────────────────────────────────────────────────────────────

function snapAt(node, t) {
  const arr = S.m.snaps.get(node);
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid + 1; else hi = mid; }
  return lo > 0 ? arr[lo - 1] : null;
}

function statusAt(node, t) {
  for (const s of S.m.segs.get(node) || []) if (t >= s.t0 && t < s.t1) return s.status;
  return 'up';
}

function cutsAt(t) {
  for (const b of S.m.bands) if (t >= b.t0 && t < b.t1) return b.cuts;
  return [];
}

let stateSig = '';
function renderState() {
  if (!S.m) return;
  const t = S.cursor;
  $('state-time').textContent = '@ ' + fmtTime(t);
  const nodes = S.trace.nodes;
  const parts = nodes.map((id) => {
    const s = snapAt(id, t);
    return `${id}:${statusAt(id, t)}:${s ? s.t : -1}`;
  });
  const cuts = cutsAt(t);
  const sig = parts.join('|') + '#' + cuts.length + (S.trace.faults.length);
  drawTopology(nodes, cuts, t);
  if (sig === stateSig) return;
  stateSig = sig;
  $('states').innerHTML = nodes.map((id) => nodeCard(id, snapAt(id, t), statusAt(id, t))).join('');
}

function nodeCard(id, snap, status) {
  const st = snap ? snap.state : {};
  const role = status === 'down' ? 'crashed' : status === 'paused' ? 'paused' : (st.role || '—');
  const rc = status === 'down' ? col('bad') : status === 'paused' ? col('pause') :
    (ROLE_COLOR[st.role] === 'follower' ? col('muted') : roleColor(st.role));
  const facts = Object.entries(st)
    .filter(([k, v]) => k !== 'role' && k !== 'log' && k !== 'kv' && (v === null || typeof v !== 'object'))
    .map(([k, v]) => `<span>${esc(k)} <b>${esc(v === null ? '–' : v)}</b></span>`).join('');
  let log = '';
  if (Array.isArray(st.log)) {
    const MAX = 48;
    const start = Math.max(0, st.log.length - MAX);
    const cells = st.log.slice(start).map((e, i) => {
      const idx = start + i + 1;
      const [term, what] = Array.isArray(e) ? e : [e.term, ''];
      const unc = st.commit !== undefined && idx > st.commit;
      return `<i class="${unc ? 'uncommitted' : ''}" style="background:${termColor(term)}" title="#${idx} · term ${term} · ${esc(what)}${unc ? ' · uncommitted' : ''}">${term}</i>`;
    }).join('');
    log = `<div class="logrow">${start ? `<span class="muted" style="font:10px var(--mono)">+${start}</span>` : ''}${cells || '<span class="muted" style="font:11px var(--mono)">empty log</span>'}</div>`;
  }
  let kv = '';
  if (st.kv && typeof st.kv === 'object') {
    const pairs = Object.entries(st.kv).map(([k, v]) => `${esc(k)}=${esc(JSON.stringify(v))}`);
    kv = `<div class="kv">${pairs.length ? pairs.join('  ') : '{}'}</div>`;
  }
  return `<div class="node ${status === 'down' ? 'down' : ''}">
    <div class="id">${esc(id)}</div>
    <div><span class="role" style="background:${alpha(rc, 0.18)};color:${rc}">${esc(role)}</span></div>
    <div></div><div class="facts">${facts}</div>
    ${log}${kv}
  </div>`;
}

const topo = $('topology');
const tg = topo.getContext('2d');
function drawTopology(nodes, cuts, t) {
  const size = 150;
  topo.width = size * dpr; topo.height = size * dpr;
  tg.setTransform(dpr, 0, 0, dpr, 0, 0);
  tg.clearRect(0, 0, size, size);
  const n = nodes.length, R = 52, cx = size / 2, cy = size / 2;
  const pos = nodes.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  const blocked = new Set(cuts.map(([a, b]) => a + '>' + b));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ab = !blocked.has(nodes[i] + '>' + nodes[j]);
      const ba = !blocked.has(nodes[j] + '>' + nodes[i]);
      if (!ab && !ba) continue;
      tg.strokeStyle = ab && ba ? alpha(col('muted'), 0.6) : alpha(col('fault'), 0.9);
      tg.setLineDash(ab && ba ? [] : [3, 3]);
      tg.lineWidth = 1.2;
      tg.beginPath(); tg.moveTo(...pos[i]); tg.lineTo(...pos[j]); tg.stroke();
    }
  }
  tg.setLineDash([]);
  nodes.forEach((id, i) => {
    const st = statusAt(id, t);
    const snap = snapAt(id, t);
    const c = st === 'down' ? col('bad') : st === 'paused' ? col('pause') : roleColor(snap && snap.state ? snap.state.role : null);
    tg.fillStyle = st === 'down' ? col('panel') : c;
    tg.strokeStyle = c;
    tg.lineWidth = 2;
    tg.beginPath(); tg.arc(pos[i][0], pos[i][1], 13, 0, Math.PI * 2); tg.fill(); tg.stroke();
    tg.fillStyle = st === 'down' ? col('bad') : col('bg');
    tg.font = '600 10px ' + getMono();
    tg.textAlign = 'center';
    tg.fillText(id, pos[i][0], pos[i][1] + 3.5);
    tg.textAlign = 'left';
  });
  if (cuts.length) {
    tg.fillStyle = col('fault');
    tg.font = '10px ' + getMono();
    tg.fillText('partitioned', 4, size - 4);
  }
}

// ── story ───────────────────────────────────────────────────────────────────

function renderStory() {
  const ol = $('story');
  ol.innerHTML = S.m.story.map((l, i) =>
    `<li data-i="${i}"><span class="t">${fmtTime(l.t)}</span><span class="${l.kind}">${esc(storyIcon(l))}${esc(l.text)}</span></li>`).join('');
  ol.querySelectorAll('li').forEach((li) => {
    li.onclick = () => {
      const l = S.m.story[+li.dataset.i];
      const span = S.view.t1 - S.view.t0;
      setView(l.t - span * 0.5, l.t + span * 0.5);
      setCursor(l.t);
    };
  });
}

function storyIcon(l) {
  return l.kind === 'fault' ? '⚡ ' : l.kind === 'culprit' ? '✗ ' : l.kind === 'violation' ? '' : '';
}

function updateStory() {
  const items = $('story').children;
  let nowIdx = -1;
  S.m.story.forEach((l, i) => { if (l.t <= S.cursor) nowIdx = i; });
  for (let i = 0; i < items.length; i++) {
    items[i].className = i === nowIdx ? 'now' : i < nowIdx ? 'past' : 'future';
  }
}

// ── lab: the in-browser multiverse ──────────────────────────────────────────

const gridCanvas = $('grid');
const gg = gridCanvas.getContext('2d');

function initGrid(n, start) {
  gridCanvas.hidden = false;
  S.grid = { n, start, cells: new Uint8Array(n) };
  drawGrid();
}

function gridGeom() {
  const w = gridCanvas.clientWidth || 268, h = 150;
  const n = S.grid.n;
  let size = Math.max(2, Math.floor(Math.sqrt((w * h) / n)));
  let cols = Math.floor(w / size);
  while (Math.ceil(n / cols) * size > h && size > 2) { size--; cols = Math.floor(w / size); }
  return { w, h, size, cols };
}

function drawGrid() {
  if (!S.grid) return;
  const { w, h, size, cols } = gridGeom();
  gridCanvas.width = Math.round(w * dpr);
  gridCanvas.height = Math.round(h * dpr);
  gg.setTransform(dpr, 0, 0, dpr, 0, 0);
  gg.clearRect(0, 0, w, h);
  const gap = size > 4 ? 1 : 0;
  const colors = [alpha(col('faint'), 0.35), alpha(col('ok'), 0.75), col('bad')];
  for (let i = 0; i < S.grid.n; i++) {
    const st = S.grid.cells[i];
    gg.fillStyle = colors[st];
    const x = (i % cols) * size, y = Math.floor(i / cols) * size;
    if (st === 2) {
      gg.fillRect(x - 1, y - 1, size + 2 - gap, size + 2 - gap);
    } else gg.fillRect(x, y, size - gap, size - gap);
  }
}

function markGrid(i, ok) {
  if (!S.grid) return;
  S.grid.cells[i] = ok ? 1 : 2;
}

gridCanvas.addEventListener('click', (ev) => {
  if (!S.grid || S.exploring) return;
  const { size, cols } = gridGeom();
  const i = Math.floor(ev.offsetY / size) * cols + Math.floor(ev.offsetX / size);
  if (i < 0 || i >= S.grid.n || S.grid.cells[i] === 0) return;
  runOne(S.grid.start + i);
});
gridCanvas.title = 'Each square is a universe. Click one to open it.';

function selectedSystem() { return SYSTEMS[$('sys').value]; }
function selectedBugs() { return [...document.querySelectorAll('#bugs input:checked')].map((x) => x.value); }

function buildLab(initialSystem, initialBugs) {
  const sel = $('sys');
  sel.innerHTML = Object.entries(SYSTEMS).map(([k, s]) => `<option value="${k}">${esc(s.title || k)}</option>`).join('');
  sel.value = initialSystem;
  sel.onchange = () => buildBugs([]);
  buildBugs(initialBugs);
}

function buildBugs(checked) {
  const sys = selectedSystem();
  $('sys-summary').textContent = sys.summary || '';
  const box = $('bugs');
  box.innerHTML = Object.entries(sys.bugs || {}).map(([k, d]) => `
    <label class="bug ${checked.includes(k) ? 'on' : ''}">
      <input type="checkbox" value="${esc(k)}" ${checked.includes(k) ? 'checked' : ''}>
      <div><b>${esc(k)}</b><span>${esc(d)}</span></div>
    </label>`).join('') +
    (Object.keys(sys.bugs || {}).length
      ? `<p class="muted small" style="margin:4px 2px 0">No bug checked = hunt for real bugs in the correct implementation.</p>`
      : `<p class="muted small" style="margin:4px 2px 0">No planted bugs — this design is wrong as written. Explore to see how.</p>`);
  box.querySelectorAll('input').forEach((inp) => {
    inp.onchange = () => inp.closest('.bug').classList.toggle('on', inp.checked);
  });
}

function labStatus(html) { $('lab-status').innerHTML = html; }

function runOne(seed) {
  const sys = selectedSystem();
  const bugs = selectedBugs();
  const scenario = makeScenario(sys, seed, { bugs });
  const r = runScenario(sys, scenario, { record: true });
  loadTrace(r.trace, sys, { fingerprint: r.fingerprint, bugs });
  labStatus(`Universe <b>#${seed}</b>: ${r.ok ? '<span class="good">every invariant held</span>' : `<span class="bad">${esc(r.violation.signature)}</span>`} · ` +
    `${r.stats.events.toLocaleString()} events, ${r.stats.sent.toLocaleString()} messages, ${scenario.faults.length + scenario.triggers.length} faults.`);
}

async function explore() {
  if (S.exploring) { S.exploring = false; return; }
  const sys = selectedSystem();
  const bugs = selectedBugs();
  const n = clamp(+$('n-seeds').value || 1000, 1, 100000);
  const start = Math.max(1, +$('n-start').value || 1);
  S.exploring = true;
  const btn = $('btn-explore');
  btn.textContent = 'Stop';
  $('btn-run').disabled = true;
  initGrid(n, start);
  const t0 = performance.now();
  let lastPaint = 0;
  const res = await exploreAsync(sys, {
    seeds: n, start, bugs,
    shouldStop: () => !S.exploring,
    onUniverse: ({ seed, result, explored }) => {
      markGrid(seed - start, result.ok);
      const now = performance.now();
      if (now - lastPaint > 60 || !result.ok) {
        lastPaint = now;
        drawGrid();
        const rate = Math.round(explored / ((now - t0) / 1000));
        labStatus(`Explored <b>${explored.toLocaleString()}</b> / ${n.toLocaleString()} universes · ${rate.toLocaleString()}/s`);
      }
    },
  });
  drawGrid();
  S.exploring = false;
  btn.textContent = 'Explore the multiverse';
  $('btn-run').disabled = false;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (!res.failures.length) {
    labStatus(`<span class="good">✓ All ${res.explored.toLocaleString()} universes upheld every invariant</span> (${secs}s). ` +
      `Click any square to open that universe.`);
    return;
  }
  const f = res.failures[0];
  labStatus(`<span class="bad">✗ Universe <b>#${f.seed}</b> broke</span> after ${res.explored.toLocaleString()} universes (${secs}s):<br>` +
    `${esc(f.result.violation.message)}<br><br><b>Shrinking…</b>`);
  await nextFrame();
  const s0 = performance.now();
  const sh = shrink(sys, f.scenario, f.result, { maxRuns: 500 });
  const replay = runScenario(sys, sh.scenario, { record: true });
  loadTrace(replay.trace, sys, { fingerprint: replay.fingerprint, bugs });
  const same = replay.fingerprint === sh.result.fingerprint;
  labStatus(`<span class="bad">✗ Universe <b>#${f.seed}</b> broke</span> after ${res.explored.toLocaleString()} universes (${secs}s).<br>` +
    `Shrunk in ${sh.runs} replays (${Math.round(performance.now() - s0)}ms): ` +
    `<b>${sh.from.faults} → ${sh.to.faults}</b> faults, ${sh.from.ops ?? 0} → ${sh.to.ops ?? 0} ops, ` +
    `${fmtTime(sh.from.duration)} → ${fmtTime(sh.to.duration)}.<br>` +
    `${same ? '✓ replay verified bit-for-bit identical.' : '⚠ replay diverged.'} Scrub the timeline or read the story below.`);
}

// ── download repro ──────────────────────────────────────────────────────────

function downloadRepro() {
  if (!S.trace || !S.trace.scenario) return;
  const sc = S.trace.scenario;
  const repro = {
    everett: 1, system: S.system.name, bugs: sc.bugs || [],
    violation: S.trace.violation, fingerprint: S.fingerprint, scenario: sc,
  };
  const blob = new Blob([JSON.stringify(repro, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `everett-${S.system.name}-${sc.seed}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A system recorded by the CLI but not bundled here: rebuild just enough of it
// from the metadata the CLI embedded (narration text, colours, model).
function foreignSystem(data) {
  const meta = data.meta || {};
  const model = Object.values(models).find((m) => m.name === meta.model) || null;
  return {
    name: data.system || 'system',
    title: meta.title || data.system || 'system',
    summary: meta.summary || '',
    messageColors: meta.messageColors || {},
    model,
    describe: (e) => e.text || null,
  };
}

// ── wiring ──────────────────────────────────────────────────────────────────

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('everett-theme', root.dataset.theme); } catch { /* storage unavailable */ }
  readColors();
  stateSig = '';
  renderState();
  draw();
  drawGrid();
}

function init() {
  try {
    const saved = localStorage.getItem('everett-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable */ }
  readColors();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); stateSig = ''; renderState(); draw(); drawGrid(); });

  $('btn-play').onclick = play;
  $('btn-prev').onclick = () => step(-1);
  $('btn-next').onclick = () => step(1);
  $('btn-fit').onclick = fit;
  $('btn-focus').onclick = focusViolation;
  $('speed').onchange = (e) => { S.speed = +e.target.value; };
  $('btn-explore').onclick = explore;
  $('btn-run').onclick = () => runOne(Math.max(1, +$('n-start').value || 1));
  $('btn-theme').onclick = toggleTheme;
  $('btn-download').onclick = downloadRepro;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || !S.m) return;
    if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'f') fit();
    else if (e.key === 'v') focusViolation();
  });
  new ResizeObserver(() => { layout(); drawGrid(); }).observe($('diagram-wrap'));

  const data = globalThis.EVERETT_DATA || {};
  if (data.trace) {
    const sys = SYSTEMS[data.system] || foreignSystem(data);
    buildLab(SYSTEMS[data.system] ? sys.name : 'raft', SYSTEMS[data.system] ? data.trace.scenario?.bugs || [] : []);
    loadTrace(data.trace, sys);
    labStatus(SYSTEMS[data.system]
      ? 'Showing a recorded universe. Explore more from here — everything runs in this page.'
      : `Showing a recorded universe of <b>${esc(sys.title)}</b>. Its code isn't bundled into this page, so the Lab explores the built-in systems.`);
  } else {
    buildLab('raft', ['forget-vote']);
    runOne(1);
    labStatus('Showing universe <b>#1</b>: a healthy Raft cluster weathering partitions, crashes and pauses. ' +
      '<b>forget-vote</b> is armed — press <b>Explore</b> to search for the universe where it breaks.');
  }
}

init();
