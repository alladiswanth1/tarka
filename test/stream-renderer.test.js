'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(opts = {}) {
  const frames = new Map();
  let nextFrame = 0;
  class Element {
    constructor() {
      this.children = [];
      this.innerHTML = '';
      this.style = {};
      this.classList = { add() {}, remove() {} };
    }
    appendChild(child) { this.children.push(child); }
    setAttribute() {}
    closest() { return null; }
    remove() {}
    querySelectorAll() { return []; }
    insertAdjacentHTML(_, html) { this.innerHTML += html; this.inserts = (this.inserts || 0) + 1; }
  }
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    prefersReducedMotion: { matches: true }, supportsInterpolateSize: false,
    renderMarkdown: (s) => s,
    requestAnimationFrame: (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    performance: { now: () => 1000 }
  });
  const src = fs.readFileSync(path.join(__dirname, '../public/src/ui/renderer.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, '');
  vm.runInContext(src, context);
  const bubble = new Element();
  const renderer = context.createStreamRenderer(bubble, { announce: false, sweep: false, ...opts });
  const inner = bubble.children[0].children[0];
  return { renderer, inner, frames, flush() {
    const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn());
  } };
}

test('a retry reset and refill in one frame does not retain the old frozen prefix', () => {
  const h = harness();
  h.renderer.update('old paragraph\n\ntail'); h.flush();
  assert.match(h.inner.children[0].innerHTML, /old paragraph/);
  h.renderer.update('');
  h.renderer.update('new paragraph, longer than the old answer\n\nnew tail');
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.doesNotMatch(h.inner.children[0].innerHTML, /old paragraph/);
  assert.match(h.inner.children[0].innerHTML, /new paragraph/);
});

test('identical stream updates do no extra rendering work and cancel releases a pending frame', () => {
  const h = harness();
  h.renderer.update('hello'); h.flush();
  h.renderer.update('hello');
  assert.equal(h.frames.size, 0);
  h.renderer.update('hello world');
  assert.equal(h.frames.size, 1);
  h.renderer.cancel();
  assert.equal(h.frames.size, 0);
  h.renderer.update('ignored after cancellation');
  assert.equal(h.frames.size, 0);
});

test('debate scroll requests coalesce and respect scrolling away before the frame', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/src/debate/arena.js'), 'utf8');
  const scroll = src.slice(src.indexOf('  let scrollFrame = 0;'), src.indexOf("  const titleEl"));
  const frames = [];
  let writes = 0;
  const context = vm.createContext({
    bodyStick: true, panel: { isConnected: true },
    body: { scrollHeight: 500, set scrollTop(value) { assert.equal(value, 500); writes++; } },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }
  });
  vm.runInContext(scroll + '\nfor (let i = 0; i < 100; i++) bodyScroll();', context);
  assert.equal(frames.length, 1);
  frames.shift()(); assert.equal(writes, 1);
  vm.runInContext('bodyScroll(); bodyStick = false;', context);
  frames.shift()(); assert.equal(writes, 1);
});

test('a transform runs once per painted frame, never per token', () => {
  let calls = 0;
  const h = harness({ transform: (t) => { calls++; return t.toUpperCase(); } });
  let full = '';
  for (const tok of 'a burst of many small tokens inside one frame'.split(' ')) {
    full += tok + ' ';
    h.renderer.update(full);
  }
  assert.equal(calls, 0, 'update() must not run the transform');
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(calls, 1);
  assert.match(h.inner.children[1].innerHTML, /A BURST OF MANY/);
});

test('a transform that briefly withholds a half-typed line keeps the frozen blocks', () => {
  // Debate hides a trailing "[" (a status marker being typed), which also
  // drops the blank line that ended the last frozen block.
  const strip = (t) => t.replace(/\n\[[^\n]*$/, '');
  const h = harness({ transform: strip });
  const stable = h.inner.children[0];
  h.renderer.update('first paragraph\n\nsecond paragraph\n\n'); h.flush();
  const inserts = stable.inserts;
  assert.match(stable.innerHTML, /second paragraph/);
  h.renderer.update('first paragraph\n\nsecond paragraph\n\n['); h.flush();
  h.renderer.update('first paragraph\n\nsecond paragraph\n\n[STATUS: AGREE]'); h.flush();
  assert.equal(stable.inserts, inserts, 'frozen blocks must not be re-rendered');
  assert.match(stable.innerHTML, /first paragraph/);
});

test('text that diverges inside the frozen region still re-renders from scratch', () => {
  const h = harness({ transform: (t) => t });
  const stable = h.inner.children[0];
  h.renderer.update('alpha\n\nbeta\n\n'); h.flush();
  h.renderer.update('alpha\n\nbeta'); h.flush(); // shorter, frozen still valid
  assert.match(stable.innerHTML, /beta/);
  h.renderer.update('alpha\n\nbetaX gamma'); h.flush(); // the old blank line is gone
  assert.doesNotMatch(stable.innerHTML, /beta/, 'a block the text no longer contains must not stay frozen');
});

test('finish() with no argument renders the latest transformed text, even before its frame', () => {
  const h = harness({ transform: (t) => t.replace('SECRET', '') });
  h.renderer.update('visible SECRET');
  h.renderer.finish();
  assert.equal(h.frames.size, 0);
  assert.equal(h.inner.innerHTML, 'visible ');
});
