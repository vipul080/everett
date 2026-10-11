// A deliberately tiny bundler: turns Everett's own ES modules into one
// classic <script>, so the lab is a single HTML file that opens from disk
// (file:// can't load modules) and needs no build tooling.
//
// It understands exactly the module syntax this codebase uses — named
// imports, namespace imports, `export function/class/const/let`, and
// `export { … } [from …]` — and refuses anything else rather than guess.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './systems.js';

const ENTRIES = ['src/index.js', 'examples/raft/index.js', 'examples/lease-lock/index.js', 'examples/gossip-register/index.js', 'viz/app.js'];

const norm = (p) => p.split(path.sep).join('/');

function resolve(from, spec) {
  if (!spec.startsWith('.')) throw new Error(`bundle: bare import "${spec}" in ${from} is not supported`);
  return norm(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
}

function transform(id, src) {
  const exported = [];
  const deps = [];
  let code = src;

  code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm, (_, names, spec) => {
    const dep = resolve(id, spec);
    deps.push(dep);
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${binds.join(', ')} } = __require(${JSON.stringify(dep)});`;
  });
  code = code.replace(/^import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/gm, (_, ns, spec) => {
    const dep = resolve(id, spec);
    deps.push(dep);
    return `const ${ns} = __require(${JSON.stringify(dep)});`;
  });
  code = code.replace(/^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm, (_, names, spec) => {
    const dep = resolve(id, spec);
    deps.push(dep);
    const pairs = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [local, as] = s.split(/\s+as\s+/);
      return `__exports.${as || local} = __m.${local};`;
    });
    return `{ const __m = __require(${JSON.stringify(dep)}); ${pairs.join(' ')} }`;
  });
  code = code.replace(/^export\s*\{([^}]*)\};?/gm, (_, names) => {
    for (const s of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [local, as] = s.split(/\s+as\s+/);
      exported.push([as || local, local]);
    }
    return '';
  });
  code = code.replace(/^export\s+((?:async\s+)?function\s*\*?\s*(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+))/gm,
    (_, decl, fn, cls, v) => {
      const name = fn || cls || v;
      exported.push([name, name]);
      return decl;
    });
  if (/^\s*(import|export)\b/m.test(code)) {
    const line = code.split('\n').find((l) => /^\s*(import|export)\b/.test(l));
    throw new Error(`bundle: unsupported module syntax in ${id}: ${line.trim()}`);
  }
  if (/import\.meta/.test(code)) throw new Error(`bundle: ${id} uses import.meta`);
  const tail = exported.map(([as, local]) => `__exports.${as} = ${local};`).join('\n');
  return { deps, code: `${code}\n${tail}` };
}

export function bundle(entries = ENTRIES) {
  const mods = new Map();
  const visit = (id) => {
    if (mods.has(id)) return;
    const src = fs.readFileSync(path.join(ROOT, id), 'utf8');
    const t = transform(id, src);
    mods.set(id, t.code);
    t.deps.forEach(visit);
  };
  entries.forEach(visit);
  const defs = [...mods].map(([id, code]) =>
    `${JSON.stringify(id)}: function (__exports, __require) {\n${code}\n}`).join(',\n');
  return `(function () {
"use strict";
const __defs = {
${defs}
};
const __cache = {};
function __require(id) {
  if (__cache[id]) return __cache[id];
  const ex = (__cache[id] = {});
  __defs[id](ex, __require);
  return ex;
}
globalThis.Everett = {
  core: __require("src/index.js"),
  systems: {
    raft: __require("examples/raft/index.js").system,
    "lease-lock": __require("examples/lease-lock/index.js").system,
    ${mods.has('examples/gossip-register/index.js') ? '"gossip-register": __require("examples/gossip-register/index.js").system,' : ''}
  },
  require: __require,
};
${mods.has('viz/app.js') ? '__require("viz/app.js");' : ''}
})();`;
}

// JSON that is safe to inline in <script>: no "</script>", and no raw
// U+2028/U+2029 (line terminators inside older JS string literals).
const safeJson = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/[\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16));

const BUNDLED = new Set(['raft', 'lease-lock', 'gossip-register']);

// `system` may be a built-in name or a full system object. For systems the
// lab doesn't bundle, we carry what the viewer needs: narration text for each
// event, message colours and the consistency model's name.
export function buildLabHtml({ trace = null, system = null } = {}) {
  const tpl = fs.readFileSync(path.join(ROOT, 'viz/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'viz/style.css'), 'utf8');
  let name = typeof system === 'string' ? system : system?.name ?? null;
  let meta = null;
  if (system && typeof system === 'object' && !BUNDLED.has(system.name) && trace) {
    trace = { ...trace, emits: trace.emits.map((e) => ({ ...e, text: system.describe ? system.describe(e) : null })) };
    meta = {
      title: system.title || system.name,
      summary: system.summary || '',
      messageColors: system.messageColors || {},
      model: system.model ? system.model.name : null,
    };
  }
  const data = `window.EVERETT_DATA = ${safeJson({ trace, system: name, meta })};`;
  return tpl
    .replace('/*__STYLE__*/', () => css)
    .replace('/*__DATA__*/', () => data)
    .replace('/*__BUNDLE__*/', () => bundle().replace(/<\/script/gi, '<\\/script'));
}
