'use strict';
/**
 * Static integrity of the browser module graph.
 *
 * There is no build step, so nothing checks that `import { foo } from './bar.js'`
 * corresponds to anything `bar.js` exports — a renamed export shows up as a
 * blank page and a console error, and only on the code path that happens to
 * run. This walks every module from app.js and fails on a broken edge.
 *
 * It also enforces the two rules ARCHITECTURE.md calls load-bearing:
 * src/state.js must import nothing, and app.js must not contain behaviour.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ENTRY = path.join(PUBLIC_DIR, 'app.js');

/** Drop comments. The `[^:]` guard keeps "https://…" out of the // rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Also drop string/template literals — for scans that must not see prose. */
function stripNonCode(src) {
  return stripComments(src)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""');
}

/** Every `import ... from '<spec>'` in a module, with its named bindings. */
function parseImports(src) {
  const out = [];
  const re = /import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1].trim();
    const spec = m[2];
    const names = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        names.push(p.split(/\s+as\s+/)[0].trim());
      }
    }
    const defaultName = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    out.push({ spec, names, hasDefault: !!defaultName && !defaultName.startsWith('*') });
  }
  // side-effect-only imports
  const bare = /import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src))) out.push({ spec: m[1], names: [], hasDefault: false });
  return out;
}

/** Everything a module exports by name. */
function parseExports(src) {
  const names = new Set();
  const listRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const bits = p.split(/\s+as\s+/);
      names.add((bits[1] || bits[0]).trim());
    }
  }
  const declRe = /export\s+(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) names.add(m[2]);
  return names;
}

function collectGraph() {
  const modules = new Map(); // absolute path -> { src, imports, exports }
  const stack = [ENTRY];
  const problems = [];
  while (stack.length) {
    const file = stack.pop();
    if (modules.has(file)) continue;
    if (!fs.existsSync(file)) {
      problems.push(`missing module: ${path.relative(PUBLIC_DIR, file)}`);
      modules.set(file, null);
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const mod = { file, raw, imports: parseImports(code), exports: parseExports(code) };
    modules.set(file, mod);
    for (const imp of mod.imports) {
      if (!imp.spec.startsWith('.')) continue;
      stack.push(path.resolve(path.dirname(file), imp.spec));
    }
  }
  return { modules, problems };
}

test('every relative import resolves to a real file', () => {
  const { modules, problems } = collectGraph();
  assert.deepEqual(problems, []);
  assert.ok(modules.size > 20, `expected the full graph, saw ${modules.size} modules`);
});

test('every named import exists in the module it comes from', () => {
  const { modules } = collectGraph();
  const broken = [];
  for (const mod of modules.values()) {
    if (!mod) continue;
    for (const imp of mod.imports) {
      if (!imp.spec.startsWith('.')) continue;
      const target = modules.get(path.resolve(path.dirname(mod.file), imp.spec));
      if (!target) continue;
      for (const name of imp.names) {
        if (!target.exports.has(name)) {
          broken.push(
            `${path.relative(PUBLIC_DIR, mod.file)} imports { ${name} } ` +
              `from ${imp.spec}, which does not export it`
          );
        }
      }
    }
  }
  assert.deepEqual(broken, [], `\n${broken.join('\n')}`);
});

test('the module graph is free of unreachable src/ modules', () => {
  const { modules } = collectGraph();
  const reached = new Set([...modules.keys()].map((f) => path.resolve(f)));
  const onDisk = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) onDisk.push(path.resolve(p));
    }
  };
  walk(path.join(PUBLIC_DIR, 'src'));
  const orphans = onDisk.filter((f) => !reached.has(f)).map((f) => path.relative(PUBLIC_DIR, f));
  assert.deepEqual(orphans, [], `dead modules: ${orphans.join(', ')}`);
});

/*
 * ARCHITECTURE.md: state.js sits at the bottom of the graph and declares `$`
 * plus the DOM refs other modules read at module scope. Give it an import and
 * it can evaluate after one of its own consumers, which surfaces as
 * "Cannot access '$' before initialization" at page load — from whichever file
 * lost the race, and only sometimes.
 */
test('src/state.js imports nothing', () => {
  const src = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, 'src', 'state.js'), 'utf8'));
  const imports = parseImports(src);
  assert.deepEqual(imports, [], `state.js must stay import-free, found: ${imports.map((i) => i.spec)}`);
});

/* contextStore.js is the shared cache both context.js and models.js read; it
 * may only depend on state.js (the graph's bottom) and modelId.js (pure,
 * import-free) or it reintroduces the cycle it exists to avoid. */
test('src/contextStore.js depends only on state.js and pure modelId.js', () => {
  const src = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, 'src', 'contextStore.js'), 'utf8'));
  const specs = parseImports(src).map((i) => i.spec).sort();
  assert.deepEqual(specs, ['./modelId.js', './state.js']);
  // modelId.js must itself stay import-free for the rule above to hold
  const mid = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, 'src', 'modelId.js'), 'utf8'));
  assert.deepEqual(parseImports(mid), []);
});

/* ARCHITECTURE.md: app.js wires DOM events to imported functions and runs the
 * boot sequence. Behaviour belongs in src/. */
test('app.js declares no non-trivial functions of its own', () => {
  const code = stripNonCode(fs.readFileSync(ENTRY, 'utf8'));
  const decls = [...code.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  assert.deepEqual(decls, [], `app.js should import behaviour, not declare it: ${decls.join(', ')}`);
});
